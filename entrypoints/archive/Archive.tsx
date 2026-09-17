import { useState, useEffect, useCallback, useMemo } from 'react';
import type { Submission } from '../../src/models/submission';
import type { FormDraft } from '../../src/models/draft';
import { createSubmissionRepository } from '../../src/storage/submission-repository';
import { createDraftRepository, consolidateDrafts } from '../../src/storage/draft-repository';
import { exportAllAsJson, downloadFile } from '../../src/export/exporter';
import { SubmissionDetail } from './SubmissionDetail';
import { DraftDetail } from './DraftDetail';
import { DraftCard, SubmissionCard } from './ArchiveCard';
import { SupportCard } from './SupportCard';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog';
import { Search, Download, FolderArchive } from 'lucide-react';

import './archive.css';

interface DeleteTarget {
  type: 'draft' | 'submission';
  id: string;
  title: string;
}

export function Archive() {
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [drafts, setDrafts] = useState<FormDraft[]>([]);
  const [selectedSubmissionId, setSelectedSubmissionId] = useState<string | null>(null);
  const [selectedDraftId, setSelectedDraftId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [isDeletingDraft, setIsDeletingDraft] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);

  const subRepo = useMemo(() => createSubmissionRepository(), []);
  const draftRepo = useMemo(() => createDraftRepository(), []);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [subsData, rawDrafts] = await Promise.all([
        subRepo.getAll().catch(() => [] as Submission[]),
        draftRepo.getAll().catch(() => [] as FormDraft[]),
      ]);

      const { canonicalDrafts } = consolidateDrafts(rawDrafts);

      subsData.sort(
        (a: Submission, b: Submission) =>
          new Date(b.updatedAt || b.createdAt).getTime() -
          new Date(a.updatedAt || a.createdAt).getTime(),
      );
      canonicalDrafts.sort(
        (a: FormDraft, b: FormDraft) =>
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      );

      setSubmissions(subsData);
      setDrafts(canonicalDrafts);
    } catch {
      setSubmissions([]);
      setDrafts([]);
    } finally {
      setLoading(false);
    }
  }, [subRepo, draftRepo]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const q = searchQuery.toLowerCase().trim();

  const filteredDrafts = drafts.filter((draft) => {
    if (!q) return true;
    const fieldsList = Object.values(draft.fields || {});
    return (
      (draft.pageTitle && draft.pageTitle.toLowerCase().includes(q)) ||
      (draft.hostname && draft.hostname.toLowerCase().includes(q)) ||
      fieldsList.some(
        (f) =>
          (f.label && f.label.toLowerCase().includes(q)) ||
          (f.value && f.value.toLowerCase().includes(q)),
      )
    );
  });

  const filteredSubmissions = submissions.filter((sub) => {
    if (!q) return true;
    return (
      (sub.submissionTitle && sub.submissionTitle.toLowerCase().includes(q)) ||
      (sub.hostname && sub.hostname.toLowerCase().includes(q)) ||
      (sub.fields &&
        sub.fields.some(
          (f) =>
            (f.label && f.label.toLowerCase().includes(q)) ||
            (f.value && f.value.toLowerCase().includes(q)),
        ))
    );
  });

  async function confirmDeleteSubmission(id: string) {
    await subRepo.delete(id);
    if (selectedSubmissionId === id) setSelectedSubmissionId(null);
    await loadData();
  }

  async function confirmDeleteDraft(id: string) {
    if (isDeletingDraft) return;

    setIsDeletingDraft(true);
    const draftToDelete = drafts.find((d) => d.id === id);
    const previousDrafts = [...drafts];

    // Optimistically remove card immediately from local UI state
    setDrafts((prev) => prev.filter((d) => d.id !== id));
    if (selectedDraftId === id) setSelectedDraftId(null);

    try {
      // 1. Delete from repository
      await draftRepo.delete(id);

      // 2. Notify background to set tombstone and alert content scripts
      try {
        const g = globalThis as unknown as {
          browser?: { runtime?: { sendMessage?: (msg: unknown) => void } };
          chrome?: { runtime?: { sendMessage?: (msg: unknown) => void } };
        };
        const runtime = g.browser?.runtime || g.chrome?.runtime;
        if (runtime && typeof runtime.sendMessage === 'function') {
          runtime.sendMessage({
            type: 'SUBMITLOG_DELETE_DRAFT',
            payload: {
              id,
              origin: draftToDelete?.origin,
              pathname: draftToDelete?.pathname,
              formFamilyKey: draftToDelete?.formFamilyKey,
            },
          });
        }
      } catch {
        // ignore background communication error
      }

      // 3. Reconcile with repository state
      await loadData();
    } catch {
      // If deletion fails, restore previous drafts
      setDrafts(previousDrafts);
    } finally {
      setIsDeletingDraft(false);
    }
  }

  async function handleUpdateSubmission(updated: Submission) {
    await subRepo.save(updated);
    await loadData();
  }

  if (selectedDraftId) {
    const selectedDraft = drafts.find((d) => d.id === selectedDraftId);
    if (selectedDraft) {
      return (
        <DraftDetail
          draft={selectedDraft}
          onBack={() => setSelectedDraftId(null)}
          onDelete={async () => {
            await confirmDeleteDraft(selectedDraft.id);
            setSelectedDraftId(null);
          }}
          onConverted={async () => {
            setSelectedDraftId(null);
            await loadData();
          }}
        />
      );
    }
  }

  if (selectedSubmissionId) {
    const selectedSub = submissions.find((s) => s.id === selectedSubmissionId);
    if (selectedSub) {
      return (
        <SubmissionDetail
          submission={selectedSub}
          onBack={() => setSelectedSubmissionId(null)}
          onDelete={async () => {
            await confirmDeleteSubmission(selectedSub.id);
            setSelectedSubmissionId(null);
          }}
          onUpdate={handleUpdateSubmission}
        />
      );
    }
  }

  const hasAnyRecords = drafts.length > 0 || submissions.length > 0;
  const hasMatchingRecords = filteredDrafts.length > 0 || filteredSubmissions.length > 0;

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      {/* Header */}
      <header className="sticky top-0 z-10 border-b border-border/70 bg-background/95 backdrop-blur-xs">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <FolderArchive className="size-5 text-primary" />
            <h1 className="text-lg font-semibold tracking-tight text-foreground">
              SubmitLog Archive
            </h1>
          </div>

          <div className="flex items-center gap-3 flex-1 max-w-md justify-end">
            <div className="relative w-full max-w-xs">
              <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground pointer-events-none" />
              <Input
                type="text"
                placeholder="Search drafts and submissions..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-8 h-9 text-xs bg-secondary/40 border-border/70 focus:bg-background transition-colors"
              />
            </div>

            {submissions.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                className="h-9 gap-1.5 text-xs shrink-0 border-border/70 shadow-xs"
                onClick={() => {
                  const json = exportAllAsJson(submissions);
                  downloadFile(json, 'submitlog_archive.json', 'application/json');
                }}
              >
                <Download className="size-3.5" />
                <span>Export all</span>
              </Button>
            )}
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 max-w-6xl w-full mx-auto px-6 py-8">
        {loading ? (
          <div className="space-y-10">
            <div className="space-y-4">
              <Skeleton className="h-6 w-44 rounded-md" />
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
                <Skeleton className="h-52 rounded-xl" />
                <Skeleton className="h-52 rounded-xl" />
                <Skeleton className="h-52 rounded-xl" />
              </div>
            </div>
          </div>
        ) : !hasAnyRecords ? (
          <div className="flex flex-col items-center justify-center py-20 text-center space-y-3 max-w-md mx-auto">
            <div className="size-12 rounded-full bg-muted flex items-center justify-center text-muted-foreground">
              <FolderArchive className="size-6" />
            </div>
            <h2 className="text-base font-semibold text-foreground">No saved forms yet.</h2>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Forms you autosave or explicitly capture will appear here.
            </p>
          </div>
        ) : !hasMatchingRecords ? (
          <div className="flex flex-col items-center justify-center py-20 text-center space-y-3 max-w-md mx-auto">
            <div className="size-12 rounded-full bg-muted flex items-center justify-center text-muted-foreground">
              <Search className="size-6" />
            </div>
            <h2 className="text-base font-semibold text-foreground">
              No matching drafts or submissions.
            </h2>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Try adjusting your search terms or clearing the filter.
            </p>
            {searchQuery && (
              <Button variant="ghost" size="sm" onClick={() => setSearchQuery('')}>
                Clear search
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-10">
            {/* Section 1: In Progress (Drafts) */}
            {filteredDrafts.length > 0 && (
              <section className="space-y-4">
                <div className="flex items-baseline justify-between border-b border-border/60 pb-2.5">
                  <div className="flex items-center gap-2.5">
                    <h2 className="text-xs font-semibold tracking-wider uppercase text-foreground">
                      In progress
                    </h2>
                    <Badge variant="draft" className="text-[11px] h-5 px-2 font-medium">
                      {filteredDrafts.length}
                    </Badge>
                  </div>
                  <span className="text-xs text-muted-foreground/80">Active autosaved drafts</span>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
                  {filteredDrafts.map((draft) => (
                    <DraftCard
                      key={draft.id}
                      draft={draft}
                      onSelect={() => setSelectedDraftId(draft.id)}
                      onDelete={() => {
                        setDeleteTarget({
                          type: 'draft',
                          id: draft.id,
                          title: draft.pageTitle || draft.hostname,
                        });
                      }}
                    />
                  ))}
                </div>
              </section>
            )}

            {/* Section 2: Saved Submissions */}
            {filteredSubmissions.length > 0 && (
              <section className="space-y-4">
                <div className="flex items-baseline justify-between border-b border-border/60 pb-2.5">
                  <div className="flex items-center gap-2.5">
                    <h2 className="text-xs font-semibold tracking-wider uppercase text-foreground">
                      Saved submissions
                    </h2>
                    <Badge variant="saved" className="text-[11px] h-5 px-2 font-medium">
                      {filteredSubmissions.length}
                    </Badge>
                  </div>
                  <span className="text-xs text-muted-foreground/80">
                    Explicitly archived snapshots
                  </span>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
                  {filteredSubmissions.map((sub) => (
                    <SubmissionCard
                      key={sub.id}
                      submission={sub}
                      onSelect={() => setSelectedSubmissionId(sub.id)}
                      onDelete={() => {
                        setDeleteTarget({
                          type: 'submission',
                          id: sub.id,
                          title: sub.submissionTitle,
                        });
                      }}
                    />
                  ))}
                </div>
              </section>
            )}
          </div>
        )}

        {/* Support Section */}
        {!loading && (
          <section className="mt-16 pt-8 border-t border-border/40">
            <SupportCard />
          </section>
        )}
      </main>

      {/* Accessible AlertDialog for Delete confirmation */}
      <AlertDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {deleteTarget?.type === 'draft' ? 'Delete draft?' : 'Delete saved submission?'}
            </AlertDialogTitle>
            <AlertDialogDescription className="text-xs leading-relaxed">
              {deleteTarget?.type === 'draft'
                ? `This removes the locally autosaved working draft for "${deleteTarget?.title}". Saved submissions are not affected.`
                : `This permanently deletes the archived submission "${deleteTarget?.title}" from your local storage. This action cannot be undone.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={async () => {
                if (!deleteTarget) return;
                const { type, id } = deleteTarget;
                setDeleteTarget(null);
                if (type === 'draft') {
                  await confirmDeleteDraft(id);
                } else {
                  await confirmDeleteSubmission(id);
                }
              }}
            >
              {deleteTarget?.type === 'draft' ? 'Delete draft' : 'Delete submission'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
