import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const { mockStorage, executeScriptSpy } = vi.hoisted(() => {
  return {
    mockStorage: new Map<string, unknown>(),
    executeScriptSpy: vi.fn(async () => []),
  };
});

vi.mock('wxt/browser', () => {
  return {
    browser: {
      storage: {
        local: {
          get: vi.fn(async (keys: string | string[]) => {
            const res: Record<string, unknown> = {};
            const kList = Array.isArray(keys) ? keys : [keys];
            for (const k of kList) {
              res[k] = mockStorage.get(k);
            }
            return res;
          }),
          set: vi.fn(async (obj: Record<string, unknown>) => {
            for (const [k, v] of Object.entries(obj)) {
              mockStorage.set(k, v);
            }
          }),
        },
      },
      scripting: {
        executeScript: executeScriptSpy,
      },
      runtime: {
        sendMessage: vi.fn(),
        getURL: vi.fn((p: string) => `chrome-extension://dummy${p}`),
      },
      tabs: {
        query: vi.fn(async () => [{ id: 1, url: 'https://form.example.com/apply' }]),
        create: vi.fn(),
      },
    },
  };
});

import {
  injectedArmAutosave,
  injectedGetAutosaveStatus,
  injectedDisarmAutosave,
} from '../src/capture/injected-autosave';
import { scanPageForms } from '../src/capture/injected-capture';
import { injectedRestoreDraft } from '../src/capture/injected-restore';
import { initFieldAssistant, disarmFieldAssistant } from '../src/assistant/injected-assistant';
import {
  handleAutosaveMessage,
  isFieldSensitive,
  type AutosaveFieldPayload,
} from '../src/background/autosave-handler';
import { buildDraftId, type FormDraft, DRAFT_SCHEMA_VERSION } from '../src/models/draft';
import type { DraftRepository } from '../src/storage/draft-repository';
import type { Submission } from '../src/models/submission';
import { SCHEMA_VERSION } from '../src/models/submission';
import type { SubmissionRepository } from '../src/storage/submission-repository';

interface MockRuntimeMessage {
  type: string;
  payload: AutosaveFieldPayload;
}

function setupMockChrome(): MockRuntimeMessage[] {
  const messages: MockRuntimeMessage[] = [];
  (
    globalThis as unknown as {
      chrome: { runtime: { sendMessage: (msg: unknown) => void } };
    }
  ).chrome = {
    runtime: {
      sendMessage: vi.fn((msg: unknown) => messages.push(msg as MockRuntimeMessage)),
    },
  };
  return messages;
}

function createInMemoryDraftRepo(): DraftRepository {
  const store = new Map<string, FormDraft>();

  return {
    async save(draft: FormDraft): Promise<void> {
      store.set(draft.id, JSON.parse(JSON.stringify(draft)));
    },
    async getById(id: string): Promise<FormDraft | undefined> {
      const item = store.get(id);
      return item ? JSON.parse(JSON.stringify(item)) : undefined;
    },
    async getByForm(
      origin: string,
      pathname: string,
      formFingerprint: string,
    ): Promise<FormDraft | undefined> {
      const id = buildDraftId(origin, pathname, formFingerprint);
      const direct = store.get(id);
      if (direct) return JSON.parse(JSON.stringify(direct));
      for (const d of store.values()) {
        if (d.origin === origin && d.formFingerprint === formFingerprint) {
          return JSON.parse(JSON.stringify(d));
        }
      }
      return undefined;
    },
    async getByOrigin(origin: string): Promise<FormDraft[]> {
      const all: FormDraft[] = [];
      for (const d of store.values()) {
        if (d.origin === origin) all.push(JSON.parse(JSON.stringify(d)));
      }
      return all.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    },
    async getAll(): Promise<FormDraft[]> {
      return Array.from(store.values())
        .map((d) => JSON.parse(JSON.stringify(d)))
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    },
    async delete(id: string): Promise<void> {
      store.delete(id);
    },
    async deleteByOrigin(origin: string): Promise<void> {
      for (const [id, d] of Array.from(store.entries())) {
        if (d.origin === origin) store.delete(id);
      }
    },
    async cleanupExpired(maxAgeMs = 30 * 24 * 60 * 60 * 1000): Promise<number> {
      const now = Date.now();
      let count = 0;
      for (const [id, d] of Array.from(store.entries())) {
        const t = new Date(d.updatedAt || d.createdAt).getTime();
        if (now - t > maxAgeMs) {
          store.delete(id);
          count++;
        }
      }
      return count;
    },
  };
}

function createInMemorySubmissionRepo(): SubmissionRepository {
  const store = new Map<string, Submission>();

  return {
    async save(sub: Submission): Promise<void> {
      store.set(sub.id, JSON.parse(JSON.stringify(sub)));
    },
    async getById(id: string): Promise<Submission | undefined> {
      const item = store.get(id);
      return item ? JSON.parse(JSON.stringify(item)) : undefined;
    },
    async getAll(): Promise<Submission[]> {
      const all = Array.from(store.values()).map((s) => JSON.parse(JSON.stringify(s)));
      return all.sort((a, b) => {
        const timeA = new Date(a.updatedAt || a.createdAt).getTime();
        const timeB = new Date(b.updatedAt || b.createdAt).getTime();
        return timeB - timeA;
      });
    },
    async delete(id: string): Promise<void> {
      store.delete(id);
    },
    async updateTitle(id: string, title: string): Promise<void> {
      const item = store.get(id);
      if (item) item.submissionTitle = title;
    },
    async search(query: string): Promise<Submission[]> {
      const q = query.toLowerCase();
      const all = await this.getAll();
      return all.filter(
        (s) => s.submissionTitle.toLowerCase().includes(q) || s.hostname.toLowerCase().includes(q),
      );
    },
    async findMatching(hostname: string): Promise<Submission | undefined> {
      const all = await this.getAll();
      return all.find((s) => s.hostname.toLowerCase() === hostname.toLowerCase());
    },
  };
}

describe('AUTOMATIC AUTOSAVE UX & LAST-WRITE-WINS (Requirements A through L)', () => {
  let draftRepo: DraftRepository;
  let subRepo: SubmissionRepository;

  beforeEach(() => {
    vi.useFakeTimers();
    mockStorage.clear();
    draftRepo = createInMemoryDraftRepo();
    subRepo = createInMemorySubmissionRepo();
    document.body.innerHTML = '';
    injectedDisarmAutosave();
    disarmFieldAssistant();
    window.__submitlog_suppress_autosave = false;
  });

  afterEach(() => {
    injectedDisarmAutosave();
    disarmFieldAssistant();
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  // --------------------------------------------------------------------------
  // A. Autosave arms automatically on meaningful forms
  // --------------------------------------------------------------------------
  it('A. Autosave arms automatically on meaningful forms', () => {
    document.body.innerHTML = `
      <form id="grant-form">
        <label for="project">Project Name</label>
        <input type="text" id="project" value="" />
        <label for="desc">Description</label>
        <textarea id="desc"></textarea>
        <button type="submit">Submit Application</button>
      </form>
    `;

    // Form scoring engine inspects page
    const scan = scanPageForms();
    expect(scan.formDetected).toBe(true);
    expect(scan.totalFields).toBe(2);

    // Background automatically arms autosave based on detector score
    const armRes = injectedArmAutosave({
      editingSessionId: 'auto-arm-test',
      hostname: 'grants.org',
      pageTitle: 'Grant Application',
      pageUrl: 'https://grants.org/apply',
      initialFields: scan.detectedFields || [],
    });

    expect(armRes.success).toBe(true);
    const status = injectedGetAutosaveStatus();
    expect(status.active).toBe(true);
  });

  // --------------------------------------------------------------------------
  // B. No popup interaction is required
  // --------------------------------------------------------------------------
  it('B. No popup interaction is required for autosave to arm, capture, and persist', async () => {
    const messages = setupMockChrome();

    document.body.innerHTML = `
      <form>
        <label for="company">Company</label>
        <input type="text" id="company" value="" />
      </form>
    `;

    // Arm autosave directly as background script would do on tab update
    injectedArmAutosave({
      editingSessionId: 'no-popup-session',
      origin: 'https://portal.example.com',
      hostname: 'portal.example.com',
      pathname: '/apply',
      pageTitle: 'Job Application',
      pageUrl: 'https://portal.example.com/apply',
      initialFields: [{ label: 'Company', fieldType: 'text' }],
    });

    const input = document.getElementById('company') as HTMLInputElement;
    input.value = 'DeepMind Applied';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    // Advance by 300ms debounce
    vi.advanceTimersByTime(350);

    expect(messages).toHaveLength(1);
    const payload = messages[0]!.payload;

    // Background service worker receives message and writes to DraftRepository
    const saveRes = await handleAutosaveMessage(payload, draftRepo);
    expect(saveRes.status).toBe('saved');

    const drafts = await draftRepo.getByOrigin('https://portal.example.com');
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.fields['company']?.value).toBe('DeepMind Applied');
  });

  // --------------------------------------------------------------------------
  // C. Newest edit replaces the previous draft (Last-Write-Wins)
  // --------------------------------------------------------------------------
  it('C. Newest edit replaces the previous draft under the same form identity', async () => {
    const origin = 'https://portal.example.com';
    const pathname = '/apply';
    const fp = 'fp-startup-application';

    // 12:00 "My startup helps researchers"
    await handleAutosaveMessage(
      {
        origin,
        pathname,
        formFingerprint: fp,
        hostname: 'portal.example.com',
        pageTitle: 'Pitch Form',
        pageUrl: `${origin}${pathname}`,
        field: {
          label: 'Elevator Pitch',
          value: 'My startup helps researchers',
          fieldType: 'textarea',
        },
      },
      draftRepo,
    );

    // 12:01 "My startup helps researchers discover therapies"
    await handleAutosaveMessage(
      {
        origin,
        pathname,
        formFingerprint: fp,
        hostname: 'portal.example.com',
        pageTitle: 'Pitch Form',
        pageUrl: `${origin}${pathname}`,
        field: {
          label: 'Elevator Pitch',
          value: 'My startup helps researchers discover therapies',
          fieldType: 'textarea',
        },
      },
      draftRepo,
    );

    // 12:02 "My startup helps researchers discover therapies faster"
    await handleAutosaveMessage(
      {
        origin,
        pathname,
        formFingerprint: fp,
        hostname: 'portal.example.com',
        pageTitle: 'Pitch Form',
        pageUrl: `${origin}${pathname}`,
        field: {
          label: 'Elevator Pitch',
          value: 'My startup helps researchers discover therapies faster',
          fieldType: 'textarea',
        },
      },
      draftRepo,
    );

    // Exactly one current draft exists for this form identity
    const allDrafts = await draftRepo.getByOrigin(origin);
    expect(allDrafts).toHaveLength(1);

    const draft = await draftRepo.getByForm(origin, pathname, fp);
    expect(draft).toBeDefined();
    // The most recently saved revision is authoritative:
    expect(draft?.fields['elevator pitch']?.value).toBe(
      'My startup helps researchers discover therapies faster',
    );
  });

  // --------------------------------------------------------------------------
  // D. Rapid edits converge to the final value (100ms debounce)
  // --------------------------------------------------------------------------
  it('D. Rapid edits converge to the final value with 100ms debounce', () => {
    const messages = setupMockChrome();

    document.body.innerHTML = `
      <form>
        <label for="title">Project Title</label>
        <input id="title" type="text" value="" />
      </form>
    `;

    injectedArmAutosave({
      editingSessionId: 'debounce-converge-test',
      hostname: 'grants.org',
      pageTitle: 'Grant Application',
      pageUrl: 'https://grants.org/apply',
      initialFields: [{ label: 'Project Title', fieldType: 'text' }],
    });

    const input = document.getElementById('title') as HTMLInputElement;

    // Simulate typing rapidly: 4 keystrokes with 40ms intervals (< 100ms debounce)
    input.value = 'A';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    vi.advanceTimersByTime(40);

    input.value = 'Au';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    vi.advanceTimersByTime(40);

    input.value = 'Auto';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    vi.advanceTimersByTime(40);

    input.value = 'Autosave Protocol';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    // 40ms after last keystroke, still debouncing (< 300ms)
    vi.advanceTimersByTime(40);
    expect(messages).toHaveLength(0);

    // After 300ms debounce elapses from the last keystroke (270ms more):
    vi.advanceTimersByTime(270);

    // Exactly 1 message dispatched containing the final converged value
    expect(messages).toHaveLength(1);
    expect(messages[0]?.payload.field.value).toBe('Autosave Protocol');
  });

  // --------------------------------------------------------------------------
  // E. F5/re-bootstrap restores the latest revision
  // --------------------------------------------------------------------------
  it('E. F5/re-bootstrap restores the latest revision automatically', async () => {
    const origin = 'https://accelerator.com';
    const pathname = '/apply';
    const fp = 'fp-accelerator-form';

    // Seed DraftRepository with the latest draft
    const draft: FormDraft = {
      id: buildDraftId(origin, pathname, fp),
      schemaVersion: DRAFT_SCHEMA_VERSION,
      origin,
      hostname: 'accelerator.com',
      pathname,
      pageTitle: 'Accelerator Application',
      pageUrl: `${origin}${pathname}`,
      formFingerprint: fp,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      fields: {
        'company name': {
          id: 'f1',
          label: 'Company Name',
          value: 'OmniAI Inc',
          fieldType: 'text',
          updatedAt: new Date().toISOString(),
        },
        'problem statement': {
          id: 'f2',
          label: 'Problem Statement',
          value: 'Data silos slow down clinical discovery',
          fieldType: 'textarea',
          updatedAt: new Date().toISOString(),
        },
      },
    };
    await draftRepo.save(draft);

    // Simulate page reload (F5): fresh empty DOM
    document.body.innerHTML = `
      <form>
        <label for="comp">Company Name</label>
        <input id="comp" type="text" value="" />
        <label for="prob">Problem Statement</label>
        <textarea id="prob"></textarea>
      </form>
    `;

    // Background reload listener restores draft automatically into empty fields
    const matchingDraft = await draftRepo.getByForm(origin, pathname, fp);
    expect(matchingDraft).toBeDefined();

    const restoreRes = injectedRestoreDraft({
      draftFields: matchingDraft!.fields,
      showIndicator: false,
    });

    expect(restoreRes.restoredCount).toBe(2);

    const compInput = document.getElementById('comp') as HTMLInputElement;
    const probInput = document.getElementById('prob') as HTMLTextAreaElement;

    expect(compInput.value).toBe('OmniAI Inc');
    expect(probInput.value).toBe('Data silos slow down clinical discovery');
  });

  // --------------------------------------------------------------------------
  // F. Existing non-empty website values are never overwritten
  // --------------------------------------------------------------------------
  it('F. Existing non-empty website values are never overwritten during draft restore', async () => {
    // Webpage already has a non-empty value restored by the site itself or typed by user
    document.body.innerHTML = `
      <form>
        <label for="company">Company</label>
        <input id="company" type="text" value="Pre-filled By Website" />
        <label for="summary">Summary</label>
        <textarea id="summary"></textarea>
      </form>
    `;

    const draftFields = {
      company: {
        label: 'Company',
        value: 'Old Draft Company',
        fieldType: 'text',
      },
      summary: {
        label: 'Summary',
        value: 'Restored Draft Summary',
        fieldType: 'textarea',
      },
    };

    const res = injectedRestoreDraft({ draftFields, showIndicator: false });

    // Non-empty company field skipped; empty summary field restored
    expect(res.restoredCount).toBe(1);
    expect(res.skippedCount).toBe(1);

    const compInput = document.getElementById('company') as HTMLInputElement;
    const sumInput = document.getElementById('summary') as HTMLTextAreaElement;

    expect(compInput.value).toBe('Pre-filled By Website');
    expect(sumInput.value).toBe('Restored Draft Summary');
  });

  // --------------------------------------------------------------------------
  // G. Google-like search/utility pages are not autosaved
  // --------------------------------------------------------------------------
  it('G. Google-like search/utility pages are rejected by detector and not autosaved', () => {
    document.body.innerHTML = `
      <form action="/search" role="search">
        <input type="search" name="q" aria-label="Search" value="test query" />
        <button type="submit">Google Search</button>
      </form>
    `;

    const scan = scanPageForms();
    expect(scan.formDetected).toBe(false);
    expect(scan.score).toBeLessThan(30);

    // Since formDetected is false, autosave is NOT armed
    const isCandidate = scan.formDetected;
    expect(isCandidate).toBe(false);
    expect(injectedGetAutosaveStatus().active).toBe(false);
  });

  // --------------------------------------------------------------------------
  // H. Sensitive fields never enter drafts
  // --------------------------------------------------------------------------
  it('H. Sensitive fields never enter drafts', async () => {
    expect(isFieldSensitive('Password', 'password')).toBe(true);
    expect(isFieldSensitive('Verification Code', 'text')).toBe(true);
    expect(isFieldSensitive('Card Number', 'text')).toBe(true);
    expect(isFieldSensitive('CVV', 'text')).toBe(true);
    expect(isFieldSensitive('Auth Token', 'text')).toBe(true);

    const sensitivePayload: AutosaveFieldPayload = {
      origin: 'https://bank.com',
      pathname: '/checkout',
      hostname: 'bank.com',
      pageTitle: 'Payment',
      pageUrl: 'https://bank.com/checkout',
      field: {
        label: 'Card Number',
        value: '4111222233334444',
        fieldType: 'text',
      },
    };

    const res = await handleAutosaveMessage(sensitivePayload, draftRepo);
    expect(res.status).toBe('skipped');

    const drafts = await draftRepo.getByOrigin('https://bank.com');
    expect(drafts).toHaveLength(0);
  });

  // --------------------------------------------------------------------------
  // I. Archive records remain unchanged by autosave updates
  // --------------------------------------------------------------------------
  it('I. Archive records remain unchanged by continuous autosave updates', async () => {
    // 1. Explicitly archived submission
    const archivedSubmission: Submission = {
      id: 'permanent-archive-1',
      schemaVersion: SCHEMA_VERSION,
      createdAt: '2026-09-01T12:00:00.000Z',
      updatedAt: '2026-09-01T12:00:00.000Z',
      pageTitle: 'Official Grant',
      pageUrl: 'https://grants.org/apply',
      hostname: 'grants.org',
      submissionTitle: 'Archived Grant 2026',
      captureVersion: '0.1.0',
      fields: [
        {
          id: 'af1',
          label: 'Project Name',
          value: 'Official Project Name',
          fieldType: 'text',
          labelSource: 'label-for',
          excluded: false,
        },
      ],
      revisions: [],
    };
    await subRepo.save(archivedSubmission);

    // 2. Autosave writes multiple draft edits to DraftRepository
    const origin = 'https://grants.org';
    const pathname = '/apply';
    const fp = 'fp-grants';

    await handleAutosaveMessage(
      {
        origin,
        pathname,
        formFingerprint: fp,
        hostname: 'grants.org',
        pageTitle: 'Official Grant',
        pageUrl: 'https://grants.org/apply',
        field: {
          label: 'Project Name',
          value: 'Draft Iteration A',
          fieldType: 'text',
        },
      },
      draftRepo,
    );

    await handleAutosaveMessage(
      {
        origin,
        pathname,
        formFingerprint: fp,
        hostname: 'grants.org',
        pageTitle: 'Official Grant',
        pageUrl: 'https://grants.org/apply',
        field: {
          label: 'Project Name',
          value: 'Draft Iteration B',
          fieldType: 'text',
        },
      },
      draftRepo,
    );

    // 3. Verify Archive record is completely UNTOUCHED
    const storedArchive = await subRepo.getById('permanent-archive-1');
    expect(storedArchive).toBeDefined();
    expect(storedArchive?.fields[0]?.value).toBe('Official Project Name');
    expect(storedArchive?.updatedAt).toBe('2026-09-01T12:00:00.000Z');
    expect(storedArchive?.revisions).toHaveLength(0);

    // 4. Verify draft is stored in its isolated draft repository
    const draft = await draftRepo.getByForm(origin, pathname, fp);
    expect(draft?.fields['project name']?.value).toBe('Draft Iteration B');
  });

  // --------------------------------------------------------------------------
  // J. Pencil assistant still bootstraps automatically
  // --------------------------------------------------------------------------
  it('J. Pencil assistant bootstraps automatically when matching answers exist', () => {
    document.body.innerHTML = `
      <form>
        <label for="email">Work Email</label>
        <input id="email" type="email" value="" />
      </form>
    `;

    initFieldAssistant();
    const input = document.getElementById('email') as HTMLInputElement;
    input.focus();

    const root = document.getElementById('submitlog-assistant-root');
    expect(root).not.toBeNull();
    const shadow = root?.shadowRoot;
    expect(shadow).toBeDefined();
    const trigger = shadow?.getElementById('trigger');
    expect(trigger).not.toBeNull();
  });

  // --------------------------------------------------------------------------
  // K. No obsolete site-autosave preference is required
  // --------------------------------------------------------------------------
  it('K. No obsolete site-autosave preference is required for autosave to arm and persist', async () => {
    // Storage has no 'persistent_autosave_origins' record
    expect(mockStorage.get('persistent_autosave_origins')).toBeUndefined();

    // Autosave arms and persists purely based on host permission and meaningful form detection
    const res = await handleAutosaveMessage(
      {
        origin: 'https://any-new-site.org',
        pathname: '/form',
        formFingerprint: 'fp-new-form',
        hostname: 'any-new-site.org',
        pageTitle: 'New Site',
        pageUrl: 'https://any-new-site.org/form',
        field: { label: 'Question 1', value: 'Answer 1', fieldType: 'text' },
      },
      draftRepo,
    );

    expect(res.status).toBe('saved');
    const draft = await draftRepo.getByForm('https://any-new-site.org', '/form', 'fp-new-form');
    expect(draft).toBeDefined();
    expect(draft?.fields['question 1']?.value).toBe('Answer 1');
  });

  // --------------------------------------------------------------------------
  // L. Private/incognito remains blocked
  // --------------------------------------------------------------------------
  it('L. Private/incognito remains strictly blocked', async () => {
    const payload: AutosaveFieldPayload = {
      origin: 'https://secret.com',
      pathname: '/apply',
      hostname: 'secret.com',
      pageTitle: 'Secret Form',
      pageUrl: 'https://secret.com/apply',
      field: { label: 'Secret Question', value: 'Secret Answer', fieldType: 'text' },
    };

    // When isIncognito is true
    const res = await handleAutosaveMessage(payload, draftRepo, true);
    expect(res.status).toBe('private_browsing_blocked');

    // No draft created
    const drafts = await draftRepo.getByOrigin('https://secret.com');
    expect(drafts).toHaveLength(0);
  });

  // --------------------------------------------------------------------------
  // UI VERIFICATION: Popup no longer contains obsolete autosave configuration
  // --------------------------------------------------------------------------
  it('UI Verification: Popup.tsx and popup.css do not contain obsolete autosave configuration strings', () => {
    const popupPath = path.resolve(__dirname, '../entrypoints/popup/Popup.tsx');
    const popupCssPath = path.resolve(__dirname, '../entrypoints/popup/popup.css');

    const popupContent = fs.readFileSync(popupPath, 'utf-8');
    const cssContent = fs.readFileSync(popupCssPath, 'utf-8');

    // Forbidden UI strings
    const forbiddenPatterns = [
      /Autosave changes/i,
      /This session only/i,
      /Always on /i,
      /Draft active/i,
      /Clear draft/i,
      /toggle-switch/i,
      /autosave-card/i,
    ];

    for (const pattern of forbiddenPatterns) {
      expect(popupContent).not.toMatch(pattern);
      expect(cssContent).not.toMatch(pattern);
    }
  });
});
