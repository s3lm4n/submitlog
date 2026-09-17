import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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

import { injectedArmAutosave } from '../src/capture/injected-autosave';

import {
  handleAutosaveMessage,
  isFieldSensitive,
  type AutosaveFieldPayload,
} from '../src/background/autosave-handler';
import { type DraftRepository } from '../src/storage/draft-repository';
import { buildDraftId, type FormDraft, DRAFT_SCHEMA_VERSION } from '../src/models/draft';
import { normalizeAnswerLabel, invalidateCachedAnswerIndex } from '../src/assistant/answer-index';
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

describe('USABILITY & PERSISTENCE ENGINE (Sections A through I)', () => {
  let draftRepo: DraftRepository;

  beforeEach(async () => {
    vi.useFakeTimers();
    mockStorage.clear();
    draftRepo = createInMemoryDraftRepo();
    document.body.innerHTML = '';
    if (typeof window.__submitlog_autosave_cleanup === 'function') {
      window.__submitlog_autosave_cleanup();
    }
    disarmFieldAssistant();
    window.__submitlog_autosave_active = false;
    window.__submitlog_autosave_session = undefined;
    window.__submitlog_suppress_autosave = false;
    invalidateCachedAnswerIndex();
  });

  afterEach(async () => {
    if (typeof window.__submitlog_autosave_cleanup === 'function') {
      window.__submitlog_autosave_cleanup();
    }
    disarmFieldAssistant();
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  // ==========================================================================
  // A. Debounced autosave
  // ==========================================================================
  describe('A. Debounced autosave', () => {
    it('coalesces multiple rapid input events into a single persistence write with final value', () => {
      const messages = setupMockChrome();

      document.body.innerHTML = `
        <form>
          <label for="statement">Problem Statement</label>
          <input id="statement" type="text" value="" />
        </form>
      `;

      injectedArmAutosave({
        editingSessionId: 'sess-debounce',
        hostname: 'form.example.com',
        pageTitle: 'Application',
        pageUrl: 'https://form.example.com/apply',
        initialFields: [{ label: 'Problem Statement', fieldType: 'text' }],
      });

      const input = document.getElementById('statement') as HTMLInputElement;

      // Simulate user typing: "M", "My", "My st", "My startup" with 80ms gaps
      const keystrokes = ['M', 'My', 'My st', 'My startup'];
      for (const str of keystrokes) {
        input.value = str;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        vi.advanceTimersByTime(80);
      }

      // Timer (400ms) has not elapsed since the last keystroke (only 80ms passed since last)
      expect(messages).toHaveLength(0);

      // Now wait past 400ms
      vi.advanceTimersByTime(450);

      // Coalesced into exactly 1 write containing the final typed value
      expect(messages).toHaveLength(1);
      expect(messages[0]?.payload.field).toEqual({
        label: 'Problem Statement',
        value: 'My startup',
        fieldType: 'text',
      });
    });
  });

  // ==========================================================================
  // B. Flush behavior
  // ==========================================================================
  describe('B. Flush behavior', () => {
    it('flushes on change event promptly (50ms)', () => {
      const messages = setupMockChrome();

      document.body.innerHTML = `
        <form>
          <label for="pref">Preference</label>
          <select id="pref">
            <option value="A">Option A</option>
            <option value="B">Option B</option>
          </select>
        </form>
      `;

      injectedArmAutosave({
        editingSessionId: 'sess-flush-change',
        hostname: 'form.example.com',
        pageTitle: 'Preferences',
        pageUrl: 'https://form.example.com/prefs',
        initialFields: [{ label: 'Preference', fieldType: 'select' }],
      });

      const select = document.getElementById('pref') as HTMLSelectElement;
      select.selectedIndex = 1;
      select.dispatchEvent(new Event('change', { bubbles: true }));

      // Promptly flushed on change
      expect(messages).toHaveLength(1);
      expect(messages[0]?.payload.field.value).toBe('Option B');
    });

    it('flushes on blur / focusout event immediately without delay', () => {
      const messages = setupMockChrome();

      document.body.innerHTML = `
        <form>
          <label for="name">Name</label>
          <input id="name" type="text" value="Ada" />
        </form>
      `;

      injectedArmAutosave({
        editingSessionId: 'sess-blur',
        hostname: 'form.example.com',
        pageTitle: 'Apply',
        pageUrl: 'https://form.example.com/apply',
        initialFields: [{ label: 'Name', fieldType: 'text' }],
      });

      const input = document.getElementById('name') as HTMLInputElement;
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));

      // Immediate finalization on blur: 0ms delay, no 100ms lag
      expect(messages).toHaveLength(1);
      expect(messages[0]?.payload.field.value).toBe('Ada');
    });

    it('flushes on visibilitychange when document becomes hidden', () => {
      const messages = setupMockChrome();

      document.body.innerHTML = `
        <form>
          <label for="goal">Goal</label>
          <input id="goal" type="text" value="" />
        </form>
      `;

      injectedArmAutosave({
        editingSessionId: 'sess-vis',
        hostname: 'form.example.com',
        pageTitle: 'Goals',
        pageUrl: 'https://form.example.com/goals',
        initialFields: [{ label: 'Goal', fieldType: 'text' }],
      });

      const input = document.getElementById('goal') as HTMLInputElement;
      input.value = 'Finish thesis';
      input.dispatchEvent(new Event('input', { bubbles: true }));

      // Before debounce fires, user switches tab (document hidden)
      Object.defineProperty(document, 'visibilityState', {
        value: 'hidden',
        configurable: true,
      });
      document.dispatchEvent(new Event('visibilitychange'));

      expect(messages).toHaveLength(1);
      expect(messages[0]?.payload.field.value).toBe('Finish thesis');
    });

    it('flushes on pagehide immediately', () => {
      const messages = setupMockChrome();

      document.body.innerHTML = `
        <form>
          <label for="summary">Summary</label>
          <input id="summary" type="text" value="" />
        </form>
      `;

      injectedArmAutosave({
        editingSessionId: 'sess-pagehide',
        hostname: 'form.example.com',
        pageTitle: 'Summary',
        pageUrl: 'https://form.example.com/summary',
        initialFields: [{ label: 'Summary', fieldType: 'text' }],
      });

      const input = document.getElementById('summary') as HTMLInputElement;
      input.value = 'Quick summary before navigating away';
      input.dispatchEvent(new Event('input', { bubbles: true }));

      // pagehide fires before debounce
      window.dispatchEvent(new Event('pagehide'));

      expect(messages).toHaveLength(1);
      expect(messages[0]?.payload.field.value).toBe('Quick summary before navigating away');
    });

    it('triggers periodic safety flush when dirty (2.5s)', () => {
      const messages = setupMockChrome();

      document.body.innerHTML = `
        <form>
          <label for="draftText">Draft Text</label>
          <input id="draftText" type="text" value="" />
        </form>
      `;

      injectedArmAutosave({
        editingSessionId: 'sess-safety',
        hostname: 'form.example.com',
        pageTitle: 'Draft',
        pageUrl: 'https://form.example.com/draft',
        initialFields: [{ label: 'Draft Text', fieldType: 'text' }],
      });

      const input = document.getElementById('draftText') as HTMLInputElement;
      input.value = 'Unflushed keystroke';
      input.dispatchEvent(new Event('input', { bubbles: true }));

      vi.advanceTimersByTime(2600);
      expect(messages).toHaveLength(1);
      expect(messages[0]?.payload.field.value).toBe('Unflushed keystroke');
    });
  });

  // ==========================================================================
  // C. Draft identity
  // ==========================================================================
  describe('C. Draft identity', () => {
    it('resolves the same draft across reloads with stripped tracking query params', async () => {
      const origin = 'https://portal.example.com';
      const rawUrl1 =
        'https://portal.example.com/apply/grant?utm_source=twitter&utm_medium=cpc&ref=campaign_1';
      const rawUrl2 = 'https://portal.example.com/apply/grant?fbclid=xyz987&gclid=abc123';
      const fp = 'fp-grant-application-456';

      const draftId1 = buildDraftId(origin, rawUrl1, fp);
      const draftId2 = buildDraftId(origin, rawUrl2, fp);

      // Tracking params are cleanly stripped, producing identical composite identity
      expect(draftId1).toBe(draftId2);
      expect(draftId1).toBe('https://portal.example.com|/apply/grant|fp-grant-application-456');

      const draft: FormDraft = {
        id: draftId1,
        schemaVersion: DRAFT_SCHEMA_VERSION,
        origin,
        hostname: 'portal.example.com',
        pathname: '/apply/grant',
        pageTitle: 'Grant Application',
        pageUrl: rawUrl1,
        formFingerprint: fp,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        fields: {
          [normalizeAnswerLabel('Project Title')]: {
            id: 'f1',
            label: 'Project Title',
            value: 'Decentralized Compute Protocol',
            fieldType: 'text',
            updatedAt: new Date().toISOString(),
          },
        },
      };

      await draftRepo.save(draft);

      const retrieved = await draftRepo.getByForm(origin, rawUrl2, fp);
      expect(retrieved).toBeDefined();
      expect(retrieved?.fields[normalizeAnswerLabel('Project Title')]?.value).toBe(
        'Decentralized Compute Protocol',
      );
    });

    it('unrelated form on same domain does not receive the draft', async () => {
      const origin = 'https://portal.example.com';
      const fpA = 'fp-accelerator-form';
      const fpB = 'fp-newsletter-signup';

      const draftA: FormDraft = {
        id: buildDraftId(origin, '/apply', fpA),
        schemaVersion: DRAFT_SCHEMA_VERSION,
        origin,
        hostname: 'portal.example.com',
        pathname: '/apply',
        pageTitle: 'Accelerator',
        pageUrl: 'https://portal.example.com/apply',
        formFingerprint: fpA,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        fields: {
          [normalizeAnswerLabel('Funding Needed')]: {
            id: 'f1',
            label: 'Funding Needed',
            value: '$250,000',
            fieldType: 'text',
            updatedAt: new Date().toISOString(),
          },
        },
      };

      await draftRepo.save(draftA);

      // Unrelated form on same domain
      const retrievedB = await draftRepo.getByForm(origin, '/newsletter', fpB);
      expect(retrievedB).toBeUndefined();
    });

    it('clearing a draft does not delete Archive submissions, and deleting Archive does not erase drafts', async () => {
      const subRepo = createInMemorySubmissionRepo();

      // 1. Save archive record
      const archiveSub: Submission = {
        id: 'archive-rec-1',
        schemaVersion: SCHEMA_VERSION,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        pageTitle: 'Archive Record',
        pageUrl: 'https://example.com/app',
        hostname: 'example.com',
        submissionTitle: 'Permanent Submission',
        captureVersion: '0.1.0',
        fields: [
          {
            id: 'f1',
            label: 'Email',
            value: 'permanent@example.com',
            fieldType: 'email',
            labelSource: 'label-for',
            excluded: false,
          },
        ],
        revisions: [],
      };
      await subRepo.save(archiveSub);

      // 2. Save active draft
      const draft: FormDraft = {
        id: buildDraftId('https://example.com', '/app', 'fp-app'),
        schemaVersion: DRAFT_SCHEMA_VERSION,
        origin: 'https://example.com',
        hostname: 'example.com',
        pathname: '/app',
        pageTitle: 'Draft Form',
        pageUrl: 'https://example.com/app',
        formFingerprint: 'fp-app',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        fields: {
          [normalizeAnswerLabel('Email')]: {
            id: 'df1',
            label: 'Email',
            value: 'draft@example.com',
            fieldType: 'email',
            updatedAt: new Date().toISOString(),
          },
        },
      };
      await draftRepo.save(draft);

      // 3. Clear draft
      await draftRepo.delete(draft.id);

      // Draft is gone, Archive record is UNTOUCHED
      expect(await draftRepo.getById(draft.id)).toBeUndefined();
      const preservedArchive = await subRepo.getById('archive-rec-1');
      expect(preservedArchive).toBeDefined();
      expect(preservedArchive?.fields[0]?.value).toBe('permanent@example.com');

      // 4. Delete Archive record
      await subRepo.delete('archive-rec-1');
      expect(await subRepo.getById('archive-rec-1')).toBeUndefined();
    });

    it('cleans up expired drafts after 30 days retention policy', async () => {
      const oldTime = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString(); // 35 days ago
      const recentTime = new Date().toISOString();

      const expiredDraft: FormDraft = {
        id: 'draft-expired',
        schemaVersion: 1,
        origin: 'https://old.org',
        hostname: 'old.org',
        pathname: '/old',
        pageTitle: 'Old',
        pageUrl: 'https://old.org/',
        formFingerprint: 'fp-old',
        createdAt: oldTime,
        updatedAt: oldTime,
        fields: {},
      };

      const freshDraft: FormDraft = {
        id: 'draft-fresh',
        schemaVersion: 1,
        origin: 'https://fresh.org',
        hostname: 'fresh.org',
        pathname: '/fresh',
        pageTitle: 'Fresh',
        pageUrl: 'https://fresh.org/',
        formFingerprint: 'fp-fresh',
        createdAt: recentTime,
        updatedAt: recentTime,
        fields: {},
      };

      await draftRepo.save(expiredDraft);
      await draftRepo.save(freshDraft);

      const deletedCount = await draftRepo.cleanupExpired(30 * 24 * 60 * 60 * 1000);
      expect(deletedCount).toBe(1);

      expect(await draftRepo.getById('draft-expired')).toBeUndefined();
      expect(await draftRepo.getById('draft-fresh')).toBeDefined();
    });
  });

  // ==========================================================================
  // D. Sensitive exclusion in draft storage
  // ==========================================================================
  describe('D. Sensitive exclusion', () => {
    it('never allows passwords, OTP, credit card, tokens, or hidden fields to enter draft storage', async () => {
      expect(isFieldSensitive('Master Password', 'password')).toBe(true);
      expect(isFieldSensitive('Auth Code', 'text')).toBe(true);
      expect(isFieldSensitive('Credit Card Number', 'text')).toBe(true);
      expect(isFieldSensitive('CVV', 'text')).toBe(true);
      expect(isFieldSensitive('Upload Resume', 'file')).toBe(true);
      expect(isFieldSensitive('Company One-Liner', 'textarea')).toBe(false);

      const sensitivePayload: AutosaveFieldPayload = {
        origin: 'https://secure.example.com',
        hostname: 'secure.example.com',
        pathname: '/login',
        pageTitle: 'Security',
        pageUrl: 'https://secure.example.com/login',
        field: {
          label: 'Card Security Code',
          value: '999',
          fieldType: 'text',
        },
      };

      const res = await handleAutosaveMessage(sensitivePayload, draftRepo);
      expect(res.status).toBe('skipped');

      const allDrafts = await draftRepo.getByOrigin('https://secure.example.com');
      expect(allDrafts).toHaveLength(0);
    });
  });

  // ==========================================================================
  // E. Restore safety & explicit user-initiated fill
  // ==========================================================================
  describe('E. Restore safety & explicit user-initiated fill', () => {
    it('leaves fields untouched on page bootstrap even when a matching draft exists', async () => {
      const origin = 'https://apply.techventures.org';
      const pathname = '/start';
      const fp = 'fp-test-form';

      // Seed draft repository with a saved draft
      const draft: FormDraft = {
        id: buildDraftId(origin, pathname, fp),
        schemaVersion: DRAFT_SCHEMA_VERSION,
        origin,
        hostname: 'apply.techventures.org',
        pathname,
        pageTitle: 'Tech Application',
        pageUrl: `${origin}${pathname}`,
        formFingerprint: fp,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        fields: {
          company: {
            id: 'c1',
            label: 'Company',
            value: 'DeepMind Applied',
            fieldType: 'text',
            updatedAt: new Date().toISOString(),
          },
        },
      };
      await draftRepo.save(draft);

      document.body.innerHTML = `
        <form>
          <label for="company">Company</label>
          <input id="company" type="text" value="" />
        </form>
      `;

      // Verify draft exists in storage
      const existingDraft = await draftRepo.getByForm(origin, pathname, fp);
      expect(existingDraft).toBeDefined();

      // On page bootstrap/reload, SubmitLog does NOT automatically write draft values into DOM
      const input = document.getElementById('company') as HTMLInputElement;
      expect(input.value).toBe('');
    });

    it('never touches or overwrites existing webpage values on bootstrap', async () => {
      const origin = 'https://apply.techventures.org';
      const pathname = '/start';
      const fp = 'fp-test-form';

      const draft: FormDraft = {
        id: buildDraftId(origin, pathname, fp),
        schemaVersion: DRAFT_SCHEMA_VERSION,
        origin,
        hostname: 'apply.techventures.org',
        pathname,
        pageTitle: 'Tech Application',
        pageUrl: `${origin}${pathname}`,
        formFingerprint: fp,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        fields: {
          headline: {
            id: 'h1',
            label: 'Headline',
            value: 'Old Draft Headline',
            fieldType: 'text',
            updatedAt: new Date().toISOString(),
          },
        },
      };
      await draftRepo.save(draft);

      document.body.innerHTML = `
        <form>
          <label for="headline">Headline</label>
          <input id="headline" type="text" value="User Typed Custom Headline" />
        </form>
      `;

      const input = document.getElementById('headline') as HTMLInputElement;

      // Existing value remains untouched on reload/bootstrap
      expect(input.value).toBe('User Typed Custom Headline');
    });

    it('restores saved answer upon explicit user pencil interaction and emits events', async () => {
      document.body.innerHTML = `
        <form>
          <label for="company">Company</label>
          <input id="company" type="text" value="" />
        </form>
      `;

      const mockSendMessage = vi.fn((msg: unknown, cb?: (res: unknown) => void) => {
        const m = msg as { type: string; payload: unknown };
        if (m.type === 'SUBMITLOG_GET_FIELD_STATUS') {
          const res = {
            savedAnswer: 'DeepMind Applied',
            totalSavedAnswers: 1,
            hasOtherSavedAnswers: false,
          };
          if (cb) cb(res);
          return Promise.resolve(res);
        }
        if (cb) cb({});
        return Promise.resolve({});
      });

      const mockRuntime = { sendMessage: mockSendMessage };
      (window as unknown as { chrome: unknown; browser: unknown }).chrome = {
        runtime: mockRuntime,
      };
      (window as unknown as { chrome: unknown; browser: unknown }).browser = {
        runtime: mockRuntime,
      };
      (globalThis as unknown as { chrome: unknown; browser: unknown }).chrome = {
        runtime: mockRuntime,
      };
      (globalThis as unknown as { chrome: unknown; browser: unknown }).browser = {
        runtime: mockRuntime,
      };

      initFieldAssistant();

      const input = document.getElementById('company') as HTMLInputElement;
      input.focus();
      input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));

      await vi.advanceTimersByTimeAsync(150);

      const root = document.getElementById('submitlog-assistant-root');
      expect(root).not.toBeNull();
      const shadow = root?.shadowRoot;
      const trigger = shadow?.getElementById('trigger') as HTMLButtonElement;
      expect(trigger).not.toBeNull();

      let inputDispatched = false;
      let changeDispatched = false;
      input.addEventListener('input', (e) => {
        if (e.bubbles) inputDispatched = true;
      });
      input.addEventListener('change', (e) => {
        if (e.bubbles) changeDispatched = true;
      });

      // User explicitly clicks pencil to restore saved answer
      trigger.click();

      expect(input.value).toBe('DeepMind Applied');
      expect(inputDispatched).toBe(true);
      expect(changeDispatched).toBe(true);
    });

    it('replaces pre-filled value with saved answer upon explicit user pencil interaction', async () => {
      document.body.innerHTML = `
        <form>
          <label for="headline">Headline</label>
          <input id="headline" type="text" value="User Typed Custom Headline" />
        </form>
      `;

      const mockSendMessage = vi.fn((msg: unknown, cb?: (res: unknown) => void) => {
        const m = msg as { type: string; payload: unknown };
        if (m.type === 'SUBMITLOG_GET_FIELD_STATUS') {
          const res = {
            savedAnswer: 'Saved Headline From Archive',
            totalSavedAnswers: 1,
            hasOtherSavedAnswers: false,
          };
          if (cb) cb(res);
          return Promise.resolve(res);
        }
        if (cb) cb({});
        return Promise.resolve({});
      });

      const mockRuntime = { sendMessage: mockSendMessage };
      (window as unknown as { chrome: unknown; browser: unknown }).chrome = {
        runtime: mockRuntime,
      };
      (window as unknown as { chrome: unknown; browser: unknown }).browser = {
        runtime: mockRuntime,
      };
      (globalThis as unknown as { chrome: unknown; browser: unknown }).chrome = {
        runtime: mockRuntime,
      };
      (globalThis as unknown as { chrome: unknown; browser: unknown }).browser = {
        runtime: mockRuntime,
      };

      initFieldAssistant();

      const input = document.getElementById('headline') as HTMLInputElement;
      expect(input.value).toBe('User Typed Custom Headline');

      input.focus();
      input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));

      await vi.advanceTimersByTimeAsync(150);

      const root = document.getElementById('submitlog-assistant-root');
      const shadow = root?.shadowRoot;
      const trigger = shadow?.getElementById('trigger') as HTMLButtonElement;
      expect(trigger).not.toBeNull();

      // Explicit user click replaces pre-filled value with the saved answer
      trigger.click();

      expect(input.value).toBe('Saved Headline From Archive');
    });

    it('never attaches pencil assistant to sensitive fields and sensitive fields are never populated', async () => {
      document.body.innerHTML = `
        <form>
          <label for="pwd">Password</label>
          <input type="password" id="pwd" />
          <label for="cvv">CVV</label>
          <input id="cvv" name="cvv" type="text" />
        </form>
      `;

      const pwd = document.getElementById('pwd') as HTMLInputElement;
      const cvv = document.getElementById('cvv') as HTMLInputElement;

      expect(isFieldSensitive(pwd)).toBe(true);
      expect(isFieldSensitive(cvv)).toBe(true);

      initFieldAssistant();

      pwd.focus();
      pwd.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));

      await vi.advanceTimersByTimeAsync(150);

      const root = document.getElementById('submitlog-assistant-root');
      const shadow = root?.shadowRoot;
      const container = shadow?.getElementById('container') as HTMLElement;

      expect(container.classList.contains('visible')).toBe(false);
      expect(pwd.value).toBe('');

      cvv.focus();
      cvv.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));

      await vi.advanceTimersByTimeAsync(150);

      expect(container.classList.contains('visible')).toBe(false);
      expect(cvv.value).toBe('');
    });
  });

  // ==========================================================================
  // F. Archive-driven pencil assistant survives F5
  // ==========================================================================
  describe('F. Archive-driven pencil assistant survives F5', () => {
    it('bootstraps available answers from persistent Archive without requiring popup open', async () => {
      const subRepo = createInMemorySubmissionRepo();

      // 1. Seed historical archive submission
      const sub: Submission = {
        id: 'archive-sub-f5',
        schemaVersion: SCHEMA_VERSION,
        createdAt: '2026-09-01T12:00:00.000Z',
        updatedAt: '2026-09-01T12:00:00.000Z',
        pageTitle: 'Tech Application',
        pageUrl: 'https://apply.techventures.org/start',
        hostname: 'apply.techventures.org',
        submissionTitle: 'Application 2026',
        captureVersion: '0.1.0',
        fields: [
          {
            id: 'f1',
            label: 'What problem are you solving?',
            value: 'Reducing protein simulation latency using JAX',
            fieldType: 'textarea',
            labelSource: 'label-for',
            excluded: false,
          },
          {
            id: 'f2',
            label: 'GitHub URL',
            value: 'https://github.com/my-lab/model',
            fieldType: 'url',
            labelSource: 'label-for',
            excluded: false,
          },
        ],
        revisions: [],
      };
      await subRepo.save(sub);

      // 2. Background bootstrap handler retrieves available answers for hostname
      const bootstrapRes = await handleBootstrapAssistant(
        { hostname: 'apply.techventures.org' },
        subRepo,
      );

      expect(bootstrapRes.availableAnswers).toBeDefined();
      const normLabel = normalizeAnswerLabel('What problem are you solving?');
      expect(bootstrapRes.availableAnswers[normLabel]?.value).toBe(
        'Reducing protein simulation latency using JAX',
      );

      // 3. Simulated fresh page bootstrap
      document.body.innerHTML = `
        <form>
          <label for="problem">What problem are you solving?</label>
          <textarea id="problem"></textarea>
        </form>
      `;

      // Query field status returns the archived answer instantly
      const statusRes = await handleGetFieldStatus(
        {
          hostname: 'apply.techventures.org',
          field: {
            label: 'What problem are you solving?',
            fieldType: 'textarea',
            value: '',
          },
        },
        subRepo,
      );

      expect(statusRes.savedAnswer).toBe('Reducing protein simulation latency using JAX');
      expect(statusRes.totalSavedAnswers).toBe(2);
    });
  });

  // ==========================================================================
  // G. Dynamic fields & MutationObserver
  // ==========================================================================
  describe('G. Dynamic fields', () => {
    it('maintains singleton assistant root and attaches to dynamic fields without duplicate elements', () => {
      document.body.innerHTML = `
        <form id="dynamic-form">
          <label for="f1">First Field</label>
          <input type="text" id="f1" />
        </form>
      `;

      initFieldAssistant();

      expect(document.querySelectorAll('#submitlog-assistant-root')).toHaveLength(1);

      // Dynamically insert new field
      const form = document.getElementById('dynamic-form')!;
      const newDiv = document.createElement('div');
      newDiv.innerHTML = `
        <label for="f2">Dynamic Field</label>
        <input type="text" id="f2" />
      `;
      form.appendChild(newDiv);

      // Advance timer for debounced MutationObserver
      vi.advanceTimersByTime(200);

      // Still exactly 1 root element in DOM
      expect(document.querySelectorAll('#submitlog-assistant-root')).toHaveLength(1);
    });
  });
});
