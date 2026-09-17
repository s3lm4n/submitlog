import * as React from 'react';
import type { FormDraft } from '../../src/models/draft';
import type { Submission } from '../../src/models/submission';
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Globe, Clock, FileEdit, Layers, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface ArchiveCardFrameProps {
  type: 'draft' | 'submission';
  title: string;
  hostname: string;
  badgeLabel: string;
  badgeVariant: 'draft' | 'saved';
  primaryActionLabel: string;
  deleteTitle: string;
  onSelect: () => void;
  onDelete: () => void;
  children: React.ReactNode;
  className?: string;
}

/**
 * Shared Archive Card Frame
 * Enforces unified visual hierarchy, spacing, radius, and hover dynamics
 * across both Draft and Saved submission cards.
 */
export function ArchiveCardFrame({
  type,
  title,
  hostname,
  badgeLabel,
  badgeVariant,
  primaryActionLabel,
  deleteTitle,
  onSelect,
  onDelete,
  children,
  className,
}: ArchiveCardFrameProps) {
  return (
    <Card
      className={cn(
        'group relative flex flex-col justify-between h-full min-h-[205px] rounded-xl border border-border/70 bg-card text-card-foreground shadow-xs transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md cursor-pointer overflow-hidden',
        type === 'draft'
          ? 'hover:border-amber-500/40 dark:hover:border-amber-500/30'
          : 'hover:border-emerald-500/40 dark:hover:border-emerald-500/30',
        className,
      )}
      onClick={onSelect}
    >
      {/* Card Header with Title, Badge, and Hostname */}
      <CardHeader className="p-4 sm:p-5 pb-2.5 space-y-2">
        <div className="flex items-start justify-between gap-3">
          <CardTitle className="text-sm font-semibold text-foreground line-clamp-2 leading-snug group-hover:text-primary transition-colors min-h-[2.5rem] flex-1">
            {title}
          </CardTitle>
          <Badge
            variant={badgeVariant}
            className="shrink-0 text-[10px] font-medium tracking-wide uppercase px-2 py-0.5 rounded-md border"
          >
            {badgeLabel}
          </Badge>
        </div>

        <div className="flex items-center gap-1.5 text-xs text-muted-foreground/80 font-mono truncate">
          <Globe className="size-3 shrink-0 text-muted-foreground/60" />
          <span className="truncate">{hostname}</span>
        </div>
      </CardHeader>

      {/* Metadata Body */}
      <CardContent className="px-4 sm:px-5 py-2 space-y-2 text-xs text-muted-foreground flex-1 flex flex-col justify-center">
        {children}
      </CardContent>

      {/* Dedicated Action Footer */}
      <CardFooter className="px-4 sm:px-5 py-3 pt-2.5 flex items-center justify-between gap-2.5 border-t border-border/50 mt-auto bg-card/40">
        <Button
          variant="default"
          size="sm"
          className="h-8 text-xs font-medium flex-1 shadow-xs transition-colors"
          onClick={(e) => {
            e.stopPropagation();
            onSelect();
          }}
        >
          {primaryActionLabel}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 text-muted-foreground/70 hover:text-destructive hover:bg-destructive/10 rounded-md transition-colors shrink-0"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          title={deleteTitle}
          aria-label={deleteTitle}
        >
          <Trash2 className="size-3.5" />
        </Button>
      </CardFooter>
    </Card>
  );
}

export interface DraftCardProps {
  draft: FormDraft;
  onSelect: () => void;
  onDelete: () => void;
}

/**
 * Draft Card Component
 * Clearly indicates working draft state with amber accents, saved time, and answer count.
 */
export function DraftCard({ draft, onSelect, onDelete }: DraftCardProps) {
  const fieldsCount = Object.keys(draft.fields || {}).length;
  const title = draft.pageTitle || draft.hostname;
  const updatedDate = new Date(draft.updatedAt);
  const timeFormatted = updatedDate.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
  const dateFormatted = updatedDate.toLocaleDateString();

  return (
    <ArchiveCardFrame
      type="draft"
      title={title}
      hostname={draft.hostname}
      badgeLabel="Draft"
      badgeVariant="draft"
      primaryActionLabel="View Draft"
      deleteTitle="Delete draft"
      onSelect={onSelect}
      onDelete={onDelete}
    >
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Clock className="size-3.5 shrink-0 text-muted-foreground/70" />
        <span className="truncate">
          Saved {timeFormatted} ({dateFormatted})
        </span>
      </div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <FileEdit className="size-3.5 shrink-0 text-muted-foreground/70" />
        <span className="truncate">
          {`${fieldsCount} saved ${fieldsCount === 1 ? 'answer' : 'answers'}`}
        </span>
      </div>
    </ArchiveCardFrame>
  );
}

export interface SubmissionCardProps {
  submission: Submission;
  onSelect: () => void;
  onDelete: () => void;
}

/**
 * Saved Submission Card Component
 * Calm, stable appearance with emerald badge, updated date, and revision/answer count.
 */
export function SubmissionCard({ submission, onSelect, onDelete }: SubmissionCardProps) {
  const answersCount = submission.fields.length;
  const revisionsCount = submission.revisions?.length || 1;
  const updatedDate = new Date(submission.updatedAt || submission.createdAt).toLocaleDateString();

  return (
    <ArchiveCardFrame
      type="submission"
      title={submission.submissionTitle}
      hostname={submission.hostname}
      badgeLabel="Saved"
      badgeVariant="saved"
      primaryActionLabel="View Details"
      deleteTitle="Delete submission"
      onSelect={onSelect}
      onDelete={onDelete}
    >
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Clock className="size-3.5 shrink-0 text-muted-foreground/70" />
        <span className="truncate">{`Updated ${updatedDate}`}</span>
      </div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Layers className="size-3.5 shrink-0 text-muted-foreground/70" />
        <span className="truncate">
          {`${answersCount} ${answersCount === 1 ? 'answer' : 'answers'} · ${revisionsCount} ${revisionsCount === 1 ? 'rev' : 'revs'}`}
        </span>
      </div>
    </ArchiveCardFrame>
  );
}
