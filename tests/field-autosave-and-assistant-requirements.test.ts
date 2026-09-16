import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const { mockStorage } = vi.hoisted(() => {
  return {
    mockStorage: new Map<string, unknown>(),
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
      runtime: {
        sendMessage: vi.fn(),
      },
    },
  };
});

import { injectedArmAutosave, injectedDisarmAutosave } from '../src/capture/injected-autosave';
import {
  handleAutosaveMessage,
  isFieldSensitive,
  type AutosaveFieldPayload,
} from '../src/background/autosave-handler';
import { type DraftRepository } from '../src/storage/draft-repository';
import { type FormDraft, DRAFT_SCHEMA_VERSION, buildDraftId } from '../src/models/draft';
import {
  type AnswerMemoryRepository,
  type AnswerMemoryEntry,
} from '../src/storage/answer-memory-repository';
import { invalidateCachedAnswerIndex } from '../src/assistant/answer-index';
import {
  handleBootstrapAssistant,
  handleGetFieldStatus,
} from '../src/background/assistant-handler';
import { initFieldAssistant, disarmFieldAssistant } from '../src/assistant/injected-assistant';
import type { Submission } from '../src/models/submission';
import { SCHEMA_VERSION } from '../src/models/submission';
import type { SubmissionRepository } from '../src/storage/submission-repository';

interface MockRuntimeMessage {
  type: string;
  payload: AutosaveFieldPayload;
}

function createInMemoryDraftRepo(): DraftRepository {
  const drafts = new Map<string, FormDraft>();

  return {
    async save(draft: FormDraft): Promise<void> {
      drafts.set(draft.id, JSON.parse(JSON.stringify(draft)));
    },
    async getById(id: string): Promise<FormDraft | undefined> {
      const d = drafts.get(id);
      return d ? JSON.parse(JSON.stringify(d)) : undefined;
    },
    async getByForm(
      origin: string,
      pathname: string,
      formFingerprint: string,
    ): Promise<FormDraft | undefined> {
      const id = buildDraftId(origin, pathname, formFingerprint);
      return this.getById(id);
    },
    async getByOrigin(origin: string): Promise<FormDraft[]> {
      const results: FormDraft[] = [];
      for (const d of drafts.values()) {
        if (d.origin === origin) {
          results.push(JSON.parse(JSON.stringify(d)));
        }
      }
      return results;
    },
    async getAll(): Promise<FormDraft[]> {
      return Array.from(drafts.values()).map((d) => JSON.parse(JSON.stringify(d)));
    },
    async delete(id: string): Promise<void> {
      drafts.delete(id);
    },
    async deleteByOrigin(origin: string): Promise<void> {
      for (const [id, d] of Array.from(drafts.entries())) {
        if (d.origin === origin) drafts.delete(id);
      }
    },
    async cleanupExpired(): Promise<number> {
      return 0;
    },
  };
}

function createInMemorySubRepo(): SubmissionRepository {
  const subs = new Map<string, Submission>();

  return {
    async save(sub: Submission): Promise<void> {
      subs.set(sub.id, JSON.parse(JSON.stringify(sub)));
    },
    async getById(id: string): Promise<Submission | undefined> {
      const s = subs.get(id);
      return s ? JSON.parse(JSON.stringify(s)) : undefined;
    },
    async getAll(): Promise<Submission[]> {
      return Array.from(subs.values()).sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );
    },
    async delete(id: string): Promise<void> {
      subs.delete(id);
    },
    async updateTitle(id: string, title: string): Promise<void> {
      const s = subs.get(id);
      if (s) s.submissionTitle = title;
    },
    async search(query: string): Promise<Submission[]> {
      const q = query.toLowerCase();
      return Array.from(subs.values()).filter(
        (s) => s.submissionTitle.toLowerCase().includes(q) || s.hostname.toLowerCase().includes(q),
      );
    },
    async findMatching(
      _hostname: string,
      _fields: Array<{ label: string; fieldType: string; excluded?: boolean }>,
    ): Promise<Submission | undefined> {
      return undefined;
    },
  };
}

function createInMemoryAnswerMemoryRepo(): AnswerMemoryRepository {
  const store = new Map<string, AnswerMemoryEntry>();

  return {
    async save(entry: AnswerMemoryEntry): Promise<void> {
      store.set(entry.normalizedLabel, JSON.parse(JSON.stringify(entry)));
    },
    async saveBatch(entries: AnswerMemoryEntry[]): Promise<void> {
      for (const e of entries) {
        store.set(e.normalizedLabel, JSON.parse(JSON.stringify(e)));
      }
    },
    async get(normalizedLabel: string): Promise<AnswerMemoryEntry | undefined> {
      const item = store.get(normalizedLabel);
      return item ? JSON.parse(JSON.stringify(item)) : undefined;
    },
    async getAllForHost(hostname: string): Promise<Record<string, AnswerMemoryEntry>> {
      const res: Record<string, AnswerMemoryEntry> = {};
      for (const item of store.values()) {
        if (!item.hostname || item.hostname === hostname) {
          res[item.normalizedLabel] = JSON.parse(JSON.stringify(item));
        }
      }
      return res;
    },
    async getAll(): Promise<AnswerMemoryEntry[]> {
      return Array.from(store.values()).map((i) => JSON.parse(JSON.stringify(i)));
    },
    async delete(normalizedLabel: string): Promise<void> {
      store.delete(normalizedLabel);
    },
    async clear(): Promise<void> {
      store.clear();
    },
  };
}

describe('SPECIFICATION COMPLIANCE: Requirements A through O & Tally Generic Flow', () => {
  let draftRepo: DraftRepository;
  let subRepo: SubmissionRepository;
  let memoryRepo: AnswerMemoryRepository;
  let sentMessages: MockRuntimeMessage[];

  beforeEach(() => {
    vi.useFakeTimers();
    mockStorage.clear();
    invalidateCachedAnswerIndex();
    draftRepo = createInMemoryDraftRepo();
    subRepo = createInMemorySubRepo();
    memoryRepo = createInMemoryAnswerMemoryRepo();
    sentMessages = [];

    const mockSendMessage = vi.fn((msg: unknown, cb?: (res: unknown) => void) => {
      const m = msg as MockRuntimeMessage;
      if (m.type === 'SUBMITLOG_AUTOSAVE_FIELD') {
        sentMessages.push(m);
        if (cb) cb({ status: 'ok' });
        return Promise.resolve({ status: 'ok' });
      }
      if (m.type === 'SUBMITLOG_BOOTSTRAP_ASSISTANT') {
        const payload = (m as unknown as { payload: { hostname: string } }).payload;
        return handleBootstrapAssistant(payload, subRepo, memoryRepo).then((res) => {
          if (cb) cb(res);
          return res;
        });
      }
      if (m.type === 'SUBMITLOG_GET_FIELD_STATUS') {
        const payload = (m as unknown as { payload: Parameters<typeof handleGetFieldStatus>[0] })
          .payload;
        return handleGetFieldStatus(payload, subRepo, memoryRepo).then((res) => {
          if (cb) cb(res);
          return res;
        });
      }
      if (cb) cb({});
      return Promise.resolve({});
    });

    const mockRuntime = { sendMessage: mockSendMessage };
    (window as unknown as { browser: unknown; chrome: unknown }).browser = { runtime: mockRuntime };
    (window as unknown as { browser: unknown; chrome: unknown }).chrome = { runtime: mockRuntime };
    (globalThis as unknown as { browser: unknown; chrome: unknown }).browser = {
      runtime: mockRuntime,
    };
    (globalThis as unknown as { browser: unknown; chrome: unknown }).chrome = {
      runtime: mockRuntime,
    };

    document.body.innerHTML = '';
  });

  afterEach(() => {
    injectedDisarmAutosave();
    disarmFieldAssistant();
    vi.clearAllTimers();
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  // --------------------------------------------------------------------------
  // Requirement A: Type b -> bk -> bkv. Focus remains: debounced saves.
  // Blur: final persisted value MUST equal bkv.
  // --------------------------------------------------------------------------
  it('Requirement A: Type b -> bk -> bkv; blur immediately finalizes "bkv"', async () => {
    document.body.innerHTML = `
      <form id="form-a">
        <label for="f-name">Name</label>
        <input id="f-name" type="text" value="" />
      </form>
    `;

    injectedArmAutosave({
      editingSessionId: 'sess-a',
      hostname: 'example.com',
      pageTitle: 'Form A',
      pageUrl: 'https://example.com/form-a',
      initialFields: [{ label: 'Name', fieldType: 'text' }],
    });

    const input = document.getElementById('f-name') as HTMLInputElement;

    // Type 'b'
    input.value = 'b';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    vi.advanceTimersByTime(50);

    // Type 'bk'
    input.value = 'bk';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    vi.advanceTimersByTime(50);

    // Type 'bkv'
    input.value = 'bkv';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    // While focused and within debounce interval (<300ms), no messages yet
    expect(sentMessages).toHaveLength(0);

    // Blur / focusout: must IMMEDIATELY finalize and persist that exact field value
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));

    // Immediately flushed without needing timer advancement
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]?.payload.field.value).toBe('bkv');

    // Save to repository
    await handleAutosaveMessage(sentMessages[0]!.payload, draftRepo, memoryRepo);
    const drafts = await draftRepo.getByOrigin('https://example.com');
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.fields['name']?.value).toBe('bkv');
  });

  // --------------------------------------------------------------------------
  // Requirement B: Immediately after blur of field A, user types into field B.
  // Field A value must not be lost or replaced.
  // --------------------------------------------------------------------------
  it('Requirement B: Blur of field A followed immediately by input in field B does not lose field A', async () => {
    document.body.innerHTML = `
      <form id="form-b">
        <label for="field-a">First Name</label>
        <input id="field-a" type="text" value="" />
        <label for="field-b">Last Name</label>
        <input id="field-b" type="text" value="" />
      </form>
    `;

    injectedArmAutosave({
      editingSessionId: 'sess-b',
      hostname: 'example.com',
      pageTitle: 'Form B',
      pageUrl: 'https://example.com/form-b',
      initialFields: [
        { label: 'First Name', fieldType: 'text' },
        { label: 'Last Name', fieldType: 'text' },
      ],
    });

    const inputA = document.getElementById('field-a') as HTMLInputElement;
    const inputB = document.getElementById('field-b') as HTMLInputElement;

    // Field A receives input
    inputA.value = 'Linus';
    inputA.dispatchEvent(new Event('input', { bubbles: true }));

    // Before debounce timer finishes, Field A loses focus and Field B immediately gets input
    inputA.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));

    // Field B receives input immediately
    inputB.value = 'Torvalds';
    inputB.dispatchEvent(new Event('input', { bubbles: true }));

    // Field A's value was flushed immediately on blur
    expect(sentMessages.length).toBeGreaterThanOrEqual(1);
    expect(sentMessages[0]?.payload.field.label).toBe('First Name');
    expect(sentMessages[0]?.payload.field.value).toBe('Linus');

    // Process Field A save
    await handleAutosaveMessage(sentMessages[0]!.payload, draftRepo, memoryRepo);

    // Now advance timer for Field B's debounce
    vi.advanceTimersByTime(350);

    expect(sentMessages.length).toBe(2);
    expect(sentMessages[1]?.payload.field.label).toBe('Last Name');
    expect(sentMessages[1]?.payload.field.value).toBe('Torvalds');

    // Process Field B save
    await handleAutosaveMessage(sentMessages[1]!.payload, draftRepo, memoryRepo);

    // Draft contains BOTH values accurately
    const drafts = await draftRepo.getByOrigin('https://example.com');
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.fields['first name']?.value).toBe('Linus');
    expect(drafts[0]?.fields['last name']?.value).toBe('Torvalds');
  });

  // --------------------------------------------------------------------------
  // Requirement C: Multiple fields dirty simultaneously.
  // pagehide / visibility hidden flushes every dirty field.
  // --------------------------------------------------------------------------
  it('Requirement C: Multiple fields dirty simultaneously: visibility hidden / pagehide flushes ALL dirty fields', async () => {
    document.body.innerHTML = `
      <form id="form-c">
        <label for="c1">Question One</label>
        <input id="c1" type="text" value="" />
        <label for="c2">Question Two</label>
        <input id="c2" type="text" value="" />
        <label for="c3">Question Three</label>
        <input id="c3" type="text" value="" />
      </form>
    `;

    injectedArmAutosave({
      editingSessionId: 'sess-c',
      hostname: 'example.com',
      pageTitle: 'Form C',
      pageUrl: 'https://example.com/form-c',
      initialFields: [
        { label: 'Question One', fieldType: 'text' },
        { label: 'Question Two', fieldType: 'text' },
        { label: 'Question Three', fieldType: 'text' },
      ],
    });

    const c1 = document.getElementById('c1') as HTMLInputElement;
    const c2 = document.getElementById('c2') as HTMLInputElement;
    const c3 = document.getElementById('c3') as HTMLInputElement;

    // Modify multiple fields without waiting for debounce timers to complete
    c1.value = 'Answer 1';
    c1.dispatchEvent(new Event('input', { bubbles: true }));

    c2.value = 'Answer 2';
    c2.dispatchEvent(new Event('input', { bubbles: true }));

    c3.value = 'Answer 3';
    c3.dispatchEvent(new Event('input', { bubbles: true }));

    expect(sentMessages).toHaveLength(0); // All currently pending in Map

    // Trigger pagehide / visibilitychange to hidden
    window.dispatchEvent(new Event('pagehide'));

    // ALL dirty fields must be flushed, not just a single one
    expect(sentMessages).toHaveLength(3);
    const flushedValues = sentMessages.map((m) => m.payload.field.value);
    expect(flushedValues).toContain('Answer 1');
    expect(flushedValues).toContain('Answer 2');
    expect(flushedValues).toContain('Answer 3');
  });

  // --------------------------------------------------------------------------
  // Requirement D: Older async write resolves after newer write.
  // Stored value remains newest revision.
  // --------------------------------------------------------------------------
  it('Requirement D: Older async write resolving after newer write is rejected (stale-write protection)', async () => {
    // Newer write with revision 5 and clientTimestamp 2000
    const newerPayload: AutosaveFieldPayload = {
      editingSessionId: 'sess-d',
      origin: 'https://example.com',
      hostname: 'example.com',
      pathname: '/test',
      pageTitle: 'Test',
      pageUrl: 'https://example.com/test',
      formFingerprint: 'form-d',
      field: {
        label: 'Bio',
        value: 'Newest Version Content',
        fieldType: 'textarea',
      },
      revision: 5,
      clientTimestamp: 2000,
    };

    // Older write with revision 4 and clientTimestamp 1000
    const olderPayload: AutosaveFieldPayload = {
      editingSessionId: 'sess-d',
      origin: 'https://example.com',
      hostname: 'example.com',
      pathname: '/test',
      pageTitle: 'Test',
      pageUrl: 'https://example.com/test',
      formFingerprint: 'form-d',
      field: {
        label: 'Bio',
        value: 'Old Stale Version Content',
        fieldType: 'textarea',
      },
      revision: 4,
      clientTimestamp: 1000,
    };

    // Newer payload arrives and is saved first
    const res1 = await handleAutosaveMessage(newerPayload, draftRepo, memoryRepo);
    expect(res1.status).toBe('saved');

    // Older payload arrives late
    const res2 = await handleAutosaveMessage(olderPayload, draftRepo, memoryRepo);
    expect(res2.status).toBe('unchanged');

    // Value in draft remains the newest version
    const drafts = await draftRepo.getByOrigin('https://example.com');
    expect(drafts[0]?.fields['bio']?.value).toBe('Newest Version Content');
  });

  // --------------------------------------------------------------------------
  // Requirement E & F: Draft is visible under "In progress", Submission under "Saved submissions"
  // --------------------------------------------------------------------------
  it('Requirements E & F: Draft is distinct from Submission in repositories and UI models', async () => {
    // 1. Create a draft
    const draft: FormDraft = {
      id: 'draft-1',
      schemaVersion: DRAFT_SCHEMA_VERSION,
      origin: 'https://example.com',
      pathname: '/apply',
      formFingerprint: 'fp-1',
      pageTitle: 'Grant Application Draft',
      pageUrl: 'https://example.com/apply',
      hostname: 'example.com',
      createdAt: '2026-09-01T10:00:00.000Z',
      updatedAt: '2026-09-01T10:05:00.000Z',
      fields: {
        q1: {
          id: 'q1',
          label: 'Project Name',
          value: 'Clean Fusion',
          fieldType: 'text',
          updatedAt: '2026-09-01T10:05:00.000Z',
        },
      },
    };
    await draftRepo.save(draft);

    // 2. Create an explicit submission
    const submission: Submission = {
      id: 'sub-1',
      schemaVersion: SCHEMA_VERSION,
      createdAt: '2026-08-15T12:00:00.000Z',
      pageTitle: 'Previous Final Application',
      pageUrl: 'https://example.com/submitted',
      hostname: 'example.com',
      submissionTitle: 'Previous Final Application - Archived',
      captureVersion: '0.1.0',
      fields: [
        {
          id: 'f1',
          label: 'Project Name',
          value: 'Quantum Battery',
          fieldType: 'text',
          labelSource: 'label-for',
          excluded: false,
        },
      ],
      revisions: [],
    };
    await subRepo.save(submission);

    // Verify draft query returns only drafts
    const allDrafts = await draftRepo.getAll();
    expect(allDrafts).toHaveLength(1);
    expect(allDrafts[0]?.pageTitle).toBe('Grant Application Draft');

    // Verify submission query returns only submissions
    const allSubs = await subRepo.getAll();
    expect(allSubs).toHaveLength(1);
    expect(allSubs[0]?.submissionTitle).toBe('Previous Final Application - Archived');
  });

  // --------------------------------------------------------------------------
  // Requirement G: Autosave updates Draft but never mutates an archived Submission
  // --------------------------------------------------------------------------
  it('Requirement G: Autosave updates Draft and Answer Memory without modifying archived Submissions', async () => {
    const originalSub: Submission = {
      id: 'sub-immutable',
      schemaVersion: SCHEMA_VERSION,
      createdAt: '2026-08-01T10:00:00.000Z',
      pageTitle: 'Immutable Form',
      pageUrl: 'https://example.com/immutable',
      hostname: 'example.com',
      submissionTitle: 'Immutable Form',
      captureVersion: '0.1.0',
      fields: [
        {
          id: 'f1',
          label: 'Organization',
          value: 'Original Non-Profit',
          fieldType: 'text',
          labelSource: 'label-for',
          excluded: false,
        },
      ],
      revisions: [],
    };
    await subRepo.save(originalSub);

    // Autosave message arrives for the same field label
    const autosavePayload: AutosaveFieldPayload = {
      editingSessionId: 'sess-g',
      origin: 'https://example.com',
      hostname: 'example.com',
      pathname: '/immutable',
      pageTitle: 'Immutable Form',
      pageUrl: 'https://example.com/immutable',
      formFingerprint: 'fp-g',
      field: {
        label: 'Organization',
        value: 'Updated Draft Name Inc',
        fieldType: 'text',
      },
    };

    await handleAutosaveMessage(autosavePayload, draftRepo, memoryRepo);

    // Verify Draft has the new value
    const draft = await draftRepo.getByOrigin('https://example.com');
    expect(draft[0]?.fields['organization']?.value).toBe('Updated Draft Name Inc');

    // Verify Answer Memory has the new value
    const memory = await memoryRepo.get('organization');
    expect(memory?.value).toBe('Updated Draft Name Inc');

    // Verify Archived Submission was NOT mutated
    const subAfter = await subRepo.getById('sub-immutable');
    expect(subAfter?.fields[0]?.value).toBe('Original Non-Profit');
  });

  // --------------------------------------------------------------------------
  // Requirement H: Finalized field value produces Answer Memory
  // --------------------------------------------------------------------------
  it('Requirement H: Finalized field value automatically updates Answer Memory', async () => {
    const payload: AutosaveFieldPayload = {
      editingSessionId: 'sess-h',
      origin: 'https://example.com',
      hostname: 'example.com',
      pathname: '/onboarding',
      pageTitle: 'Onboarding',
      pageUrl: 'https://example.com/onboarding',
      formFingerprint: 'fp-h',
      field: {
        label: 'GitHub Username',
        value: 'octocat-engineer',
        fieldType: 'text',
      },
    };

    await handleAutosaveMessage(payload, draftRepo, memoryRepo);

    const memEntry = await memoryRepo.get('github username');
    expect(memEntry).toBeDefined();
    expect(memEntry?.value).toBe('octocat-engineer');
    expect(memEntry?.fieldType).toBe('text');
  });

  // --------------------------------------------------------------------------
  // Requirement I & J: Reload restores pencil without popup; single click fills saved answer
  // --------------------------------------------------------------------------
  it('Requirements I & J: After reload, pencil appears for matching field and single click fills value', async () => {
    // Pre-populate Answer Memory with saved answer
    await memoryRepo.save({
      id: 'localhost::full name',
      normalizedLabel: 'full name',
      label: 'Full Name',
      fieldType: 'text',
      value: 'Katherine Johnson',
      updatedAt: '2026-09-01T12:00:00.000Z',
      hostname: 'localhost',
      source: 'draft',
    });

    document.body.innerHTML = `
      <form id="reload-form">
        <label for="reload-name">Full Name</label>
        <input id="reload-name" type="text" value="" />
      </form>
    `;

    // Bootstrap assistant directly without opening popup or archive
    initFieldAssistant();

    const input = document.getElementById('reload-name') as HTMLInputElement;
    input.focus();
    input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));

    // Await background status message resolution
    await vi.advanceTimersByTimeAsync(150);

    // Assistant root and trigger exist
    const root = document.getElementById('submitlog-assistant-root');
    expect(root).not.toBeNull();
    const shadow = root?.shadowRoot;
    const trigger = shadow?.getElementById('trigger') as HTMLButtonElement;
    expect(trigger).not.toBeNull();

    // Single click on pencil immediately fills the field with native events
    let inputDispatched = false;
    let changeDispatched = false;
    input.addEventListener('input', () => {
      inputDispatched = true;
    });
    input.addEventListener('change', () => {
      changeDispatched = true;
    });

    trigger.click();

    expect(input.value).toBe('Katherine Johnson');
    expect(inputDispatched).toBe(true);
    expect(changeDispatched).toBe(true);
    expect(trigger.classList.contains('state-saved')).toBe(true);
  });

  // --------------------------------------------------------------------------
  // Requirement K: No saved answer means no pencil
  // --------------------------------------------------------------------------
  it('Requirement K: No saved answer means no pencil assistant displayed', async () => {
    document.body.innerHTML = `
      <form id="empty-memory-form">
        <label for="unique-unknown">Obscure Question With No Memory</label>
        <input id="unique-unknown" type="text" value="" />
      </form>
    `;

    initFieldAssistant();

    const input = document.getElementById('unique-unknown') as HTMLInputElement;
    input.focus();
    input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));

    const root = document.getElementById('submitlog-assistant-root');
    const shadow = root?.shadowRoot;
    const container = shadow?.getElementById('container') as HTMLElement;

    // Container is hidden because no saved answer exists
    expect(container.classList.contains('visible')).toBe(false);
  });

  // --------------------------------------------------------------------------
  // Requirement L: Sensitive field never autosaves, enters Answer Memory, or receives pencil
  // --------------------------------------------------------------------------
  it('Requirement L: Sensitive fields never autosave, never enter Answer Memory, never get pencil', async () => {
    document.body.innerHTML = `
      <form id="sec-form">
        <input id="sec-pass" type="password" name="user_password" />
        <input id="sec-otp" type="text" autocomplete="one-time-code" />
        <input id="sec-cvv" type="text" name="card_cvv" />
      </form>
    `;

    const pass = document.getElementById('sec-pass') as HTMLInputElement;
    const otp = document.getElementById('sec-otp') as HTMLInputElement;
    const cvv = document.getElementById('sec-cvv') as HTMLInputElement;

    expect(isFieldSensitive(pass)).toBe(true);
    expect(isFieldSensitive(otp)).toBe(true);
    expect(isFieldSensitive(cvv)).toBe(true);

    injectedArmAutosave({
      editingSessionId: 'sess-sec',
      hostname: 'example.com',
      pageTitle: 'Sec Form',
      pageUrl: 'https://example.com/sec',
      initialFields: [
        { label: 'Password', fieldType: 'text' },
        { label: 'OTP', fieldType: 'text' },
      ],
    });

    pass.value = 'Secret123!';
    pass.dispatchEvent(new Event('input', { bubbles: true }));
    pass.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));

    otp.value = '987654';
    otp.dispatchEvent(new Event('input', { bubbles: true }));
    otp.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));

    vi.advanceTimersByTime(500);

    // No messages sent for sensitive inputs
    expect(sentMessages).toHaveLength(0);

    // Even if background somehow received a sensitive field, it skips it
    const fakeSensitivePayload: AutosaveFieldPayload = {
      editingSessionId: 'sess-sec',
      origin: 'https://example.com',
      hostname: 'example.com',
      pathname: '/sec',
      pageTitle: 'Sec Form',
      pageUrl: 'https://example.com/sec',
      formFingerprint: 'sec-fp',
      field: {
        label: 'Enter Password',
        value: 'SuperSecret',
        fieldType: 'text',
      },
    };

    const res = await handleAutosaveMessage(fakeSensitivePayload, draftRepo, memoryRepo);
    expect(res.status).toBe('skipped');

    // Never enters Answer Memory
    const mem = await memoryRepo.get('enter password');
    expect(mem).toBeUndefined();
  });

  // --------------------------------------------------------------------------
  // Requirement M: No browser.tabs.onUpdated runtime exception
  // --------------------------------------------------------------------------
  it('Requirement M: Background entrypoint does NOT call browser.tabs.onUpdated', () => {
    const bgPath = path.resolve(__dirname, '../entrypoints/background.ts');
    const bgContent = fs.readFileSync(bgPath, 'utf8');

    expect(bgContent.includes('browser.tabs.onUpdated')).toBe(false);
    expect(bgContent.includes('tabs.onUpdated')).toBe(false);
  });

  // --------------------------------------------------------------------------
  // Requirement N: No "Receiving end does not exist" unhandled rejection
  // --------------------------------------------------------------------------
  it('Requirement N: Message dispatches attach .catch() to avoid unhandled rejections', () => {
    const contentScriptPath = path.resolve(__dirname, '../src/capture/injected-autosave.ts');
    const contentContent = fs.readFileSync(contentScriptPath, 'utf8');

    // Injected autosave contains silent error catcher
    expect(contentContent.includes('.catch(() => {})')).toBe(true);

    const bgPath = path.resolve(__dirname, '../entrypoints/background.ts');
    const bgContent = fs.readFileSync(bgPath, 'utf8');
    expect(bgContent.includes('.catch(() => {})')).toBe(true);
  });

  // --------------------------------------------------------------------------
  // Requirement O: Build scripts exist and manifests support cross-browser targets
  // --------------------------------------------------------------------------
  it('Requirement O: Package scripts configure cross-browser builds for Chrome and Firefox', () => {
    const pkgPath = path.resolve(__dirname, '../package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

    expect(pkg.scripts['build']).toBeDefined();
    expect(pkg.scripts['build:firefox']).toBeDefined();
  });

  // --------------------------------------------------------------------------
  // Tally-Specific Test (Section 11) using tally-style-application.html
  // --------------------------------------------------------------------------
  it('Section 11: Tally-style dynamic form flow with immediate blur finalization and one-click fill', async () => {
    const fixturePath = path.resolve(__dirname, 'fixtures/tally-style-application.html');
    const html = fs.readFileSync(fixturePath, 'utf8');
    document.body.innerHTML = html;

    // Step 1: Arm autosave on the Tally page
    injectedArmAutosave({
      editingSessionId: 'sess-tally',
      hostname: 'forms.example.com',
      pageTitle: 'Startup Accelerator Application - Tally Flow',
      pageUrl: 'https://forms.example.com/tally-app',
      initialFields: [
        { label: 'First Name', fieldType: 'text' },
        { label: 'Last Name', fieldType: 'text' },
      ],
    });

    const fnInput = document.getElementById('tally_first_name') as HTMLInputElement;
    const lnInput = document.getElementById('tally_last_name') as HTMLInputElement;

    // Step 2: User types into First Name
    fnInput.value = 'Satoshi';
    fnInput.dispatchEvent(new Event('input', { bubbles: true }));

    // Step 3: Focus moves to Last Name (blur on First Name)
    fnInput.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    lnInput.focus();
    lnInput.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));

    // Step 4: First Name must be finalized immediately (0ms delay)
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]?.payload.field.label).toBe('First Name');
    expect(sentMessages[0]?.payload.field.value).toBe('Satoshi');

    // Background processes the autosave message
    await handleAutosaveMessage(sentMessages[0]!.payload, draftRepo, memoryRepo);

    // Verify Answer Memory has recorded 'Satoshi' for 'first name'
    const memory = await memoryRepo.get('first name');
    expect(memory).toBeDefined();
    expect(memory?.value).toBe('Satoshi');

    // Step 5: Page reloads / rerenders dynamically (simulate new clean DOM)
    document.body.innerHTML = html;
    initFieldAssistant();

    const newFnInput = document.getElementById('tally_first_name') as HTMLInputElement;
    expect(newFnInput.value).toBe('');

    // Step 6: Focus into blank First Name: pencil appears because saved answer exists
    newFnInput.focus();
    newFnInput.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));

    // Await background status message resolution
    await vi.advanceTimersByTimeAsync(150);

    const root = document.getElementById('submitlog-assistant-root');
    expect(root).not.toBeNull();
    const shadow = root?.shadowRoot;
    const trigger = shadow?.getElementById('trigger') as HTMLButtonElement;
    expect(trigger).not.toBeNull();

    // Step 7: One-click fill
    trigger.click();

    // Field is immediately filled with the saved answer
    expect(newFnInput.value).toBe('Satoshi');
    expect(trigger.classList.contains('state-saved')).toBe(true);
  });
});
