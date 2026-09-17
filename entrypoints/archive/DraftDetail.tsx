import { useState } from 'react';
import type { FormDraft } from '../../src/models/draft';
import { SCHEMA_VERSION, type Submission, type CapturedField } from '../../src/models/submission';
import { generateId } from '../../src/utils/id';
import { createSubmissionRepository } from '../../src/storage/submission-repository';

import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
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
import {
  ArrowLeft,
  Copy,
  Check,
  Trash2,
  ExternalLink,
  Info,
  Archive as ArchiveIcon,
} from 'lucide-react';

interface Props {
  draft: FormDraft;
  onBack: () => void;
  onDelete: () => void;
  onConverted: () => void;
}

export function DraftDetail({ draft, onBack, onDelete, onConverted }: Props) {
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);
  const [isConverting, setIsConverting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  async function copyToClipboard(text: string, feedbackId: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopyFeedback(feedbackId);
      setTimeout(() => setCopyFeedback(null), 2000);
    } catch {
      // ignore
    }
  }

  function handleCopyAllMarkdown() {
    const fields = Object.values(draft.fields);
    let md = `# Draft: ${draft.pageTitle || draft.hostname}\n\n`;
    md += `**Site:** ${draft.hostname}\n`;
    md += `**URL:** ${draft.pageUrl}\n`;
    md += `**Last Saved:** ${new Date(draft.updatedAt).toLocaleString()}\n`;
    md += `**Status:** In progress (Draft)\n\n---\n\n## Saved Answers\n\n`;

    for (const f of fields) {
      md += `### ${f.label}\n${f.value}\n\n`;
    }

    md += `*Autosaved by SubmitLog on ${new Date(draft.updatedAt).toLocaleString()}*\n`;
    copyToClipboard(md, 'all-md');
  }

  async function handleConvertToSubmission() {
    setIsConverting(true);
    try {
      const now = new Date().toISOString();
      const fields: CapturedField[] = Object.values(draft.fields).map((f) => ({
        id: f.id || generateId(),
        label: f.label,
        value: f.value,
        fieldType: f.fieldType,
        labelSource: 'label-for',
        excluded: false,
      }));

      const newSubmission: Submission = {
        id: generateId(),
        schemaVersion: SCHEMA_VERSION,
        createdAt: draft.createdAt || now,
        updatedAt: now,
        pageTitle: draft.pageTitle || draft.hostname,
        pageUrl: draft.pageUrl || `https://${draft.hostname}/`,
        hostname: draft.hostname,
        submissionTitle: `${draft.pageTitle || draft.hostname} - Captured Draft`,
        fields,
        captureVersion: '0.1.0',
        formFingerprint: draft.formFingerprint,
        revisions: [
          {
            id: generateId(),
            createdAt: now,
            fields: fields.map((f) => ({ ...f })),
            changeNote: 'Converted from autosaved draft to permanent submission',
          },
        ],
      };

      const repo = createSubmissionRepository();
      await repo.save(newSubmission);
      onConverted();
    } catch {
      setIsConverting(false);
    }
  }

  const fieldsList = Object.values(draft.fields);

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      {/* Header */}
      <header className="sticky top-0 z-10 border-b bg-background/95 backdrop-blur-xs">
        <div className="max-w-4xl mx-auto px-6 py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="sm" onClick={onBack} className="h-8 gap-1.5 px-2 text-xs">
              <ArrowLeft className="size-3.5" />
              <span>Back to Archive</span>
            </Button>
            <Badge variant="draft" className="text-xs">
              Draft (In Progress)
            </Badge>
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleCopyAllMarkdown}
              className="h-8 text-xs gap-1.5"
            >
              {copyFeedback === 'all-md' ? (
                <Check className="size-3.5 text-emerald-600" />
              ) : (
                <Copy className="size-3.5" />
              )}
              <span>{copyFeedback === 'all-md' ? 'Copied' : 'Copy as Markdown'}</span>
            </Button>
            <Button
              variant="default"
              size="sm"
              onClick={handleConvertToSubmission}
              disabled={isConverting}
              className="h-8 text-xs gap-1.5 font-medium"
            >
              <ArchiveIcon className="size-3.5" />
              <span>{isConverting ? 'Saving...' : 'Save as submission'}</span>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowDeleteConfirm(true)}
              className="h-8 px-2 text-xs text-muted-foreground hover:text-destructive hover:bg-destructive/10"
              title="Delete draft"
            >
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        </div>
      </header>

      {/* Main Detail Content */}
      <main className="flex-1 max-w-4xl w-full mx-auto px-6 py-8 space-y-6">
        {/* Title & Metadata Card */}
        <Card className="p-6 space-y-3">
          <CardTitle className="text-xl font-bold tracking-tight text-foreground">
            {draft.pageTitle || draft.hostname}
          </CardTitle>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <a
              href={draft.pageUrl}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1 font-mono hover:text-primary transition-colors"
            >
              <span>{draft.hostname}</span>
              <ExternalLink className="size-3" />
            </a>
            <span>·</span>
            <span>Last saved {new Date(draft.updatedAt).toLocaleString()}</span>
            <span>·</span>
            <span>
              {fieldsList.length} saved {fieldsList.length === 1 ? 'answer' : 'answers'}
            </span>
          </div>

          <div className="flex items-start gap-2 rounded-md bg-amber-500/10 border border-amber-500/20 p-3 text-xs text-amber-800 dark:text-amber-300">
            <Info className="size-4 shrink-0 mt-0.5" />
            <p className="leading-relaxed">
              This is an in-progress autosaved working draft. It updates automatically as you type
              in form fields and remains separate from explicit snapshots in your Archive.
            </p>
          </div>
        </Card>

        {/* Q&A Cards */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold tracking-tight text-foreground uppercase tracking-wider text-xs">
              Saved Answers ({fieldsList.length})
            </h2>
          </div>

          {fieldsList.length === 0 ? (
            <Card className="p-8 text-center text-xs text-muted-foreground">
              No answers saved in this draft.
            </Card>
          ) : (
            <div className="space-y-2.5">
              {fieldsList.map((f, idx) => {
                const feedbackKey = `field-${idx}`;
                return (
                  <Card
                    key={f.id || idx}
                    className="p-4 space-y-2 hover:border-primary/40 transition-colors"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="text-xs font-semibold text-foreground/90 leading-snug">
                        {f.label}
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => copyToClipboard(f.value, feedbackKey)}
                        className="h-6 px-2 text-[11px] gap-1 shrink-0 text-muted-foreground hover:text-foreground"
                      >
                        {copyFeedback === feedbackKey ? (
                          <Check className="size-3 text-emerald-600" />
                        ) : (
                          <Copy className="size-3" />
                        )}
                        <span>{copyFeedback === feedbackKey ? 'Copied' : 'Copy'}</span>
                      </Button>
                    </div>

                    <div className="text-xs text-foreground font-mono bg-muted/30 p-2.5 rounded-md break-words whitespace-pre-wrap">
                      {f.value || <span className="italic text-muted-foreground/60">(empty)</span>}
                    </div>

                    <div className="flex items-center justify-between text-[11px] text-muted-foreground pt-1">
                      <Badge variant="outline" className="text-[10px] h-4 font-mono font-normal">
                        {f.fieldType}
                      </Badge>
                      <span>Saved {new Date(f.updatedAt).toLocaleTimeString()}</span>
                    </div>
                  </Card>
                );
              })}
            </div>
          )}
        </div>
      </main>

      {/* Delete Confirmation Alert Dialog */}
      <AlertDialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete draft?</AlertDialogTitle>
            <AlertDialogDescription className="text-xs leading-relaxed">
              This removes the locally autosaved working draft for &quot;
              {draft.pageTitle || draft.hostname}&quot;. Saved submissions are not affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                setShowDeleteConfirm(false);
                onDelete();
              }}
            >
              Delete draft
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
