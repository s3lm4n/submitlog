import { useState } from 'react';
import type { Submission } from '../../src/models/submission';
import { exportAsJson, exportAsMarkdown, downloadFile } from '../../src/export/exporter';

import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
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
  Download,
  Trash2,
  ExternalLink,
  Pencil,
  Layers,
  FileText,
} from 'lucide-react';

interface Props {
  submission: Submission;
  onBack: () => void;
  onDelete: () => void;
  onUpdate: (updated: Submission) => void;
}

export function SubmissionDetail({ submission, onBack, onDelete, onUpdate }: Props) {
  const [editingTitle, setEditingTitle] = useState(false);
  const [title, setTitle] = useState(submission.submissionTitle);
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);
  const [showRevisions, setShowRevisions] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  async function handleTitleSave() {
    if (title.trim() && title !== submission.submissionTitle) {
      await onUpdate({ ...submission, submissionTitle: title.trim() });
    }
    setEditingTitle(false);
  }

  async function copyToClipboard(text: string, feedbackId: string) {
    await navigator.clipboard.writeText(text);
    setCopyFeedback(feedbackId);
    setTimeout(() => setCopyFeedback(null), 2000);
  }

  function handleExportJson() {
    const json = exportAsJson(submission);
    const slug = submission.hostname.replace(/\./g, '_');
    downloadFile(json, `submitlog_${slug}_${submission.id.slice(0, 8)}.json`, 'application/json');
  }

  function handleExportMarkdown() {
    const md = exportAsMarkdown(submission);
    const slug = submission.hostname.replace(/\./g, '_');
    downloadFile(md, `submitlog_${slug}_${submission.id.slice(0, 8)}.md`, 'text/markdown');
  }

  function handleCopyAllMarkdown() {
    const md = exportAsMarkdown(submission);
    copyToClipboard(md, 'all-md');
  }

  const revisionsCount = submission.revisions?.length || 1;
  const lastUpdated = submission.updatedAt || submission.createdAt;

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
            <Badge variant="saved" className="text-xs">
              Saved Submission
            </Badge>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {submission.revisions && submission.revisions.length > 1 && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowRevisions(!showRevisions)}
                className="h-8 text-xs gap-1.5"
              >
                <Layers className="size-3.5" />
                <span>{showRevisions ? 'Hide Revisions' : `Revisions (${revisionsCount})`}</span>
              </Button>
            )}

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
              <span>{copyFeedback === 'all-md' ? 'Copied' : 'Copy all as Markdown'}</span>
            </Button>

            <Button
              variant="outline"
              size="sm"
              onClick={handleExportJson}
              className="h-8 text-xs gap-1.5"
            >
              <Download className="size-3.5" />
              <span>JSON</span>
            </Button>

            <Button
              variant="outline"
              size="sm"
              onClick={handleExportMarkdown}
              className="h-8 text-xs gap-1.5"
            >
              <FileText className="size-3.5" />
              <span>Markdown</span>
            </Button>

            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowDeleteConfirm(true)}
              className="h-8 px-2 text-xs text-muted-foreground hover:text-destructive hover:bg-destructive/10"
              title="Delete submission"
            >
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 max-w-4xl w-full mx-auto px-6 py-8 space-y-6">
        {/* Title & Metadata Card */}
        <Card className="p-6 space-y-3">
          {editingTitle ? (
            <div className="flex items-center gap-2">
              <Input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onBlur={handleTitleSave}
                onKeyDown={(e) => e.key === 'Enter' && handleTitleSave()}
                autoFocus
                className="text-lg font-semibold h-10"
              />
              <Button size="sm" onClick={handleTitleSave} className="h-10 px-4 text-xs">
                Save
              </Button>
            </div>
          ) : (
            <div
              className="group flex items-center gap-2 cursor-pointer"
              onClick={() => setEditingTitle(true)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === 'Enter' && setEditingTitle(true)}
            >
              <CardTitle className="text-xl font-bold tracking-tight text-foreground group-hover:text-primary transition-colors">
                {submission.submissionTitle}
              </CardTitle>
              <Pencil className="size-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
            </div>
          )}

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <a
              href={submission.pageUrl}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1 font-mono hover:text-primary transition-colors"
            >
              <span>{submission.hostname}</span>
              <ExternalLink className="size-3" />
            </a>
            <span>·</span>
            <span>Updated {new Date(lastUpdated).toLocaleString()}</span>
            <span>·</span>
            <span>
              {revisionsCount} {revisionsCount === 1 ? 'revision' : 'revisions'}
            </span>
            <span>·</span>
            <span>{submission.fields.length} fields</span>
          </div>
        </Card>

        {/* Revisions History Drawer/Panel */}
        {showRevisions && submission.revisions && submission.revisions.length > 0 && (
          <div className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Revision History
            </h3>
            <div className="space-y-2">
              {submission.revisions.map((rev, idx) => (
                <Card key={rev.id} className="p-3 bg-muted/20 border-muted">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-semibold text-foreground">
                      Revision {revisionsCount - idx}
                    </span>
                    <span className="text-muted-foreground">
                      {new Date(rev.createdAt).toLocaleString()}
                    </span>
                  </div>
                  {rev.changeNote && (
                    <p className="text-xs text-foreground/80 mt-1">{rev.changeNote}</p>
                  )}
                  <div className="text-[11px] text-muted-foreground mt-1">
                    {rev.fields.length} fields captured
                  </div>
                </Card>
              ))}
            </div>
          </div>
        )}

        {/* Question & Answer Cards */}
        <div className="space-y-3">
          <h2 className="text-sm font-semibold tracking-tight text-foreground uppercase tracking-wider text-xs">
            Saved Answers ({submission.fields.length})
          </h2>

          {submission.fields.length === 0 ? (
            <Card className="p-8 text-center text-xs text-muted-foreground">
              No fields captured in this submission.
            </Card>
          ) : (
            <div className="space-y-2.5">
              {submission.fields.map((f) => (
                <Card
                  key={f.id}
                  className="p-4 space-y-2 hover:border-primary/40 transition-colors"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="text-xs font-semibold text-foreground/90 leading-snug">
                      {f.label}
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => copyToClipboard(f.value, f.id)}
                      className="h-6 px-2 text-[11px] gap-1 shrink-0 text-muted-foreground hover:text-foreground"
                    >
                      {copyFeedback === f.id ? (
                        <Check className="size-3 text-emerald-600" />
                      ) : (
                        <Copy className="size-3" />
                      )}
                      <span>{copyFeedback === f.id ? 'Copied' : 'Copy'}</span>
                    </Button>
                  </div>

                  <div className="text-xs text-foreground font-mono bg-muted/30 p-2.5 rounded-md break-words whitespace-pre-wrap">
                    {f.value || <span className="italic text-muted-foreground/60">(empty)</span>}
                  </div>
                </Card>
              ))}
            </div>
          )}
        </div>
      </main>

      {/* Delete Confirmation Alert Dialog */}
      <AlertDialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete saved submission?</AlertDialogTitle>
            <AlertDialogDescription className="text-xs leading-relaxed">
              This permanently deletes the archived submission &quot;{submission.submissionTitle}
              &quot; from your local storage. This action cannot be undone.
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
              Delete submission
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
