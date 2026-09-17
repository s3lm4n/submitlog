import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { DraftCard, SubmissionCard, ArchiveCardFrame } from '../entrypoints/archive/ArchiveCard';
import type { FormDraft } from '../src/models/draft';
import type { Submission } from '../src/models/submission';
import { DRAFT_SCHEMA_VERSION } from '../src/models/draft';
import { SCHEMA_VERSION } from '../src/models/submission';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('Archive Card Polish Suite (Draft and Submission Cards)', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
      root = null;
    }
    if (container && container.parentNode) {
      container.parentNode.removeChild(container);
    }
  });

  const mockDraft: FormDraft = {
    id: 'draft-101',
    schemaVersion: DRAFT_SCHEMA_VERSION,
    origin: 'https://apply.techventures.org',
    pathname: '/application',
    formFingerprint: 'fp-101',
    pageTitle: 'TechVentures Seed Accelerator 2026 Application',
    pageUrl: 'https://apply.techventures.org/application',
    hostname: 'apply.techventures.org',
    createdAt: '2026-09-17T10:00:00.000Z',
    updatedAt: '2026-09-17T14:30:00.000Z',
    fields: {
      f1: {
        id: 'f1',
        label: 'Startup Name',
        value: 'Antigravity AI',
        fieldType: 'text',
        updatedAt: '2026-09-17T14:30:00.000Z',
      },
      f2: {
        id: 'f2',
        label: 'Pitch',
        value: 'Autonomous agentic developer tools',
        fieldType: 'textarea',
        updatedAt: '2026-09-17T14:30:00.000Z',
      },
    },
  };

  const mockSubmission: Submission = {
    id: 'sub-202',
    schemaVersion: SCHEMA_VERSION,
    createdAt: '2026-09-16T12:00:00.000Z',
    updatedAt: '2026-09-17T09:15:00.000Z',
    pageTitle: 'Y Combinator Winter 2027 Application',
    pageUrl: 'https://apply.ycombinator.com',
    hostname: 'apply.ycombinator.com',
    submissionTitle: 'Y Combinator Winter 2027 Application - Final',
    captureVersion: '0.1.0',
    fields: [
      {
        id: 'f1',
        label: 'Company Name',
        value: 'Antigravity AI',
        fieldType: 'text',
        labelSource: 'label-for',
        excluded: false,
      },
      {
        id: 'f2',
        label: 'Describe what you make',
        value: 'Pair programming platform',
        fieldType: 'textarea',
        labelSource: 'label-for',
        excluded: false,
      },
      {
        id: 'f3',
        label: 'Target URL',
        value: 'https://antigravity.dev',
        fieldType: 'url',
        labelSource: 'label-for',
        excluded: false,
      },
    ],
    revisions: [
      {
        id: 'rev-1',
        createdAt: '2026-09-16T12:00:00.000Z',
        fields: [],
      },
      {
        id: 'rev-2',
        createdAt: '2026-09-17T09:15:00.000Z',
        fields: [],
      },
    ],
  };

  // 1. Shared Card Frame Structure & Styling
  it('ArchiveCardFrame renders unified hierarchy, title clamping, and dedicated footer', () => {
    const html = renderToString(
      <ArchiveCardFrame
        type="draft"
        title="Test Title"
        hostname="example.com"
        badgeLabel="Draft"
        badgeVariant="draft"
        primaryActionLabel="View Draft"
        deleteTitle="Delete draft"
        onSelect={() => {}}
        onDelete={() => {}}
      >
        <span>Test metadata</span>
      </ArchiveCardFrame>,
    );

    // Rounded-xl card with elevated background and subtle border
    expect(html).toContain('rounded-xl');
    expect(html).toContain('border-border/70');
    expect(html).toContain('bg-card');
    expect(html).toContain('min-h-[205px]');

    // Title clamping and reserved height for stable grid alignment
    expect(html).toContain('line-clamp-2');
    expect(html).toContain('min-h-[2.5rem]');

    // Hostname with globe icon
    expect(html).toContain('example.com');
    expect(html).toContain('font-mono');

    // Dedicated footer separated with border
    expect(html).toContain('border-t border-border/50');
    expect(html).toContain('View Draft');
    expect(html).toContain('Delete draft');
  });

  // 2. Draft Card Presentation & Hierarchy
  it('DraftCard renders amber Draft badge, last saved time, answer count, and View Draft action', () => {
    const html = renderToString(
      <DraftCard draft={mockDraft} onSelect={() => {}} onDelete={() => {}} />,
    );

    // Title and hostname
    expect(html).toContain('TechVentures Seed Accelerator 2026 Application');
    expect(html).toContain('apply.techventures.org');

    // Status badge is Draft with amber styling
    expect(html).toContain('Draft');
    expect(html).toContain('amber');

    // Metadata: Saved time and saved answers
    expect(html).toContain('Saved');
    expect(html).toContain('2 saved answers');

    // Primary action and delete button
    expect(html).toContain('View Draft');
    expect(html).toContain('Delete draft');
  });

  // 3. Saved Submission Card Presentation & Hierarchy
  it('SubmissionCard renders emerald Saved badge, updated date, revision count, and View Details action', () => {
    const html = renderToString(
      <SubmissionCard submission={mockSubmission} onSelect={() => {}} onDelete={() => {}} />,
    );

    // Title and hostname
    expect(html).toContain('Y Combinator Winter 2027 Application - Final');
    expect(html).toContain('apply.ycombinator.com');

    // Status badge is Saved with emerald styling
    expect(html).toContain('Saved');
    expect(html).toContain('emerald');

    // Metadata: Updated date and answers/revisions count
    expect(html).toContain('Updated');
    expect(html).toContain('3 answers · 2 revs');

    // Primary action and delete button
    expect(html).toContain('View Details');
    expect(html).toContain('Delete submission');
  });

  // 4. Interactive Behavior & Event Propagation
  it('Card click invokes onSelect while button clicks call proper callbacks without double-triggering', async () => {
    const onSelectDraft = vi.fn();
    const onDeleteDraft = vi.fn();

    await act(async () => {
      root = createRoot(container);
      root.render(
        <DraftCard draft={mockDraft} onSelect={onSelectDraft} onDelete={onDeleteDraft} />,
      );
    });

    const card = container.querySelector('.group') as HTMLElement;
    expect(card).not.toBeNull();

    // Clicking card container triggers onSelect
    await act(async () => {
      card.click();
    });
    expect(onSelectDraft).toHaveBeenCalledTimes(1);

    // Clicking primary button "View Draft"
    const viewBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('View Draft'),
    );
    expect(viewBtn).toBeDefined();

    await act(async () => {
      viewBtn?.click();
    });
    expect(onSelectDraft).toHaveBeenCalledTimes(2);

    // Clicking delete button calls onDelete without calling onSelect again
    const deleteBtn = container.querySelector('button[aria-label="Delete draft"]') as HTMLElement;
    expect(deleteBtn).not.toBeNull();

    await act(async () => {
      deleteBtn.click();
    });
    expect(onDeleteDraft).toHaveBeenCalledTimes(1);
    expect(onSelectDraft).toHaveBeenCalledTimes(2); // Still 2, stopPropagation prevented bubble!
  });
});
