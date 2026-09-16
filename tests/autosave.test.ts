import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  injectedArmAutosave,
  injectedDisarmAutosave,
  injectedGetAutosaveStatus,
} from '../src/capture/injected-autosave';
import {
  handleAutosaveMessage,
  isFieldSensitive,
  type AutosaveFieldPayload,
} from '../src/background/autosave-handler';
import { type SubmissionRepository } from '../src/storage/submission-repository';
import { matchForm } from '../src/matching/field-matcher';
import type { Submission } from '../src/models/submission';
import { SCHEMA_VERSION } from '../src/models/submission';

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

function createInMemoryRepo(): SubmissionRepository {
  const store = new Map<string, Submission>();

  return {
    async save(sub: Submission): Promise<void> {
      const copy = JSON.parse(JSON.stringify(sub));
      store.set(sub.id, copy);
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
      if (item) {
        item.submissionTitle = title;
        item.updatedAt = new Date().toISOString();
      }
    },
    async search(query: string): Promise<Submission[]> {
      const lower = query.toLowerCase();
      return Array.from(store.values()).filter(
        (s) =>
          s.submissionTitle.toLowerCase().includes(lower) ||
          s.hostname.toLowerCase().includes(lower),
      );
    },
    async findMatching(
      hostname: string,
      fields: Array<{ label: string; fieldType: string; excluded?: boolean }>,
    ): Promise<Submission | undefined> {
      const all = await this.getAll();
      for (const sub of all) {
        const match = matchForm(hostname, fields, sub);
        if (match.isMatch) return sub;
      }
      return undefined;
    },
  };
}

describe('Privacy-Preserving Field-Level Autosave', () => {
  let repo: SubmissionRepository;

  beforeEach(async () => {
    vi.useFakeTimers();
    repo = createInMemoryRepo();
    // Clean up DOM
    document.body.innerHTML = '';
    // Reset window state
    if (typeof window.__submitlog_autosave_cleanup === 'function') {
      window.__submitlog_autosave_cleanup();
    }
    window.__submitlog_autosave_active = false;
    window.__submitlog_autosave_session = undefined;
    window.__submitlog_suppress_autosave = false;
  });

  afterEach(async () => {
    if (typeof window.__submitlog_autosave_cleanup === 'function') {
      window.__submitlog_autosave_cleanup();
    }
    vi.useRealTimers();
  });

  describe('Scenario A: Text input focusout triggers autosave', () => {
    it('dispatches debounced autosave message on focusout', () => {
      const messages = setupMockChrome();

      document.body.innerHTML = `
        <form>
          <label for="fullName">Full Name</label>
          <input id="fullName" type="text" value="Ada Lovelace" />
        </form>
      `;

      injectedArmAutosave({
        editingSessionId: 'session-a',
        hostname: 'apply.example.org',
        pageTitle: 'Application',
        pageUrl: 'https://apply.example.org/form',
        initialFields: [{ label: 'Full Name', fieldType: 'text' }],
      });

      const input = document.getElementById('fullName') as HTMLInputElement;
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));

      expect(messages).toHaveLength(0); // Debounced 300ms

      vi.advanceTimersByTime(350);

      expect(messages).toHaveLength(1);
      expect(messages[0]?.type).toBe('SUBMITLOG_AUTOSAVE_FIELD');
      expect(messages[0]?.payload.field).toEqual({
        label: 'Full Name',
        value: 'Ada Lovelace',
        fieldType: 'text',
      });
      expect(messages[0]?.payload.editingSessionId).toBe('session-a');
    });
  });

  describe('Scenario B: Textarea focusout triggers autosave', () => {
    it('captures textarea value on focusout', () => {
      const messages = setupMockChrome();

      document.body.innerHTML = `
        <form>
          <label for="bio">Short Bio</label>
          <textarea id="bio">Mathematician and writer.</textarea>
        </form>
      `;

      injectedArmAutosave({
        editingSessionId: 'session-b',
        hostname: 'apply.example.org',
        pageTitle: 'Application',
        pageUrl: 'https://apply.example.org/form',
        initialFields: [{ label: 'Short Bio', fieldType: 'textarea' }],
      });

      const textarea = document.getElementById('bio') as HTMLTextAreaElement;
      textarea.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));

      vi.advanceTimersByTime(350);

      expect(messages).toHaveLength(1);
      expect(messages[0]?.payload.field).toEqual({
        label: 'Short Bio',
        value: 'Mathematician and writer.',
        fieldType: 'textarea',
      });
    });
  });

  describe('Scenario C: Select change triggers autosave', () => {
    it('captures select selected text on change', () => {
      const messages = setupMockChrome();

      document.body.innerHTML = `
        <form>
          <label for="country">Country</label>
          <select id="country">
            <option value="US">United States</option>
            <option value="UK" selected>United Kingdom</option>
          </select>
        </form>
      `;

      injectedArmAutosave({
        editingSessionId: 'session-c',
        hostname: 'apply.example.org',
        pageTitle: 'Application',
        pageUrl: 'https://apply.example.org/form',
        initialFields: [{ label: 'Country', fieldType: 'select' }],
      });

      const select = document.getElementById('country') as HTMLSelectElement;
      select.dispatchEvent(new Event('change', { bubbles: true }));

      vi.advanceTimersByTime(350);

      expect(messages).toHaveLength(1);
      expect(messages[0]?.payload.field).toEqual({
        label: 'Country',
        value: 'United Kingdom',
        fieldType: 'select',
      });
    });
  });

  describe('Scenario D: Radio change triggers autosave', () => {
    it('captures chosen radio on change', () => {
      const messages = setupMockChrome();

      document.body.innerHTML = `
        <fieldset>
          <legend>Experience Level</legend>
          <label><input type="radio" name="exp" id="exp-mid" value="Mid" /> Mid</label>
          <label><input type="radio" name="exp" id="exp-senior" value="Senior" checked /> Senior</label>
        </fieldset>
      `;

      injectedArmAutosave({
        editingSessionId: 'session-d',
        hostname: 'apply.example.org',
        pageTitle: 'Application',
        pageUrl: 'https://apply.example.org/form',
        initialFields: [{ label: 'Experience Level', fieldType: 'radio' }],
      });

      const radio = document.getElementById('exp-senior') as HTMLInputElement;
      radio.dispatchEvent(new Event('change', { bubbles: true }));

      vi.advanceTimersByTime(350);

      expect(messages).toHaveLength(1);
      expect(messages[0]?.payload.field.label).toBe('Experience Level');
      expect(messages[0]?.payload.field.fieldType).toBe('radio');
      expect(messages[0]?.payload.field.value).toBe('Senior');
    });
  });

  describe('Scenario E: Checkbox change triggers autosave', () => {
    it('captures checkbox checked state on change', () => {
      const messages = setupMockChrome();

      document.body.innerHTML = `
        <form>
          <label for="agree">
            <input type="checkbox" id="agree" checked />
            I agree to terms and conditions
          </label>
        </form>
      `;

      injectedArmAutosave({
        editingSessionId: 'session-e',
        hostname: 'apply.example.org',
        pageTitle: 'Application',
        pageUrl: 'https://apply.example.org/form',
        initialFields: [{ label: 'I agree to terms and conditions', fieldType: 'checkbox' }],
      });

      const cb = document.getElementById('agree') as HTMLInputElement;
      cb.dispatchEvent(new Event('change', { bubbles: true }));

      vi.advanceTimersByTime(350);

      expect(messages).toHaveLength(1);
      expect(messages[0]?.payload.field.value).toBe('Checked');
    });
  });

  describe('Scenario F: Password / OTP / sensitive fields are NEVER autosaved', () => {
    it('injected listener completely ignores password, OTP, and sensitive inputs', () => {
      const messages = setupMockChrome();

      document.body.innerHTML = `
        <form>
          <input type="password" id="pwd" name="password" value="Secret123!" />
          <input type="text" id="otp" autocomplete="one-time-code" value="987654" />
          <input type="text" id="card" name="cardnumber" value="4111222233334444" />
          <input type="hidden" id="csrf" name="token" value="csrf-token-abc" />
          <input type="file" id="resume" />
        </form>
      `;

      injectedArmAutosave({
        editingSessionId: 'session-f',
        hostname: 'apply.example.org',
        pageTitle: 'Application',
        pageUrl: 'https://apply.example.org/form',
        initialFields: [],
      });

      document.getElementById('pwd')?.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      document.getElementById('otp')?.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      document.getElementById('card')?.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      document.getElementById('csrf')?.dispatchEvent(new Event('change', { bubbles: true }));
      document.getElementById('resume')?.dispatchEvent(new Event('change', { bubbles: true }));

      vi.advanceTimersByTime(1000);

      expect(messages).toHaveLength(0);
    });

    it('background handler skips sensitive fields if somehow received', async () => {
      expect(isFieldSensitive('Password', 'password')).toBe(true);
      expect(isFieldSensitive('Credit Card Number', 'text')).toBe(true);
      expect(isFieldSensitive('One Time Code', 'text')).toBe(true);
      expect(isFieldSensitive('Resume', 'file')).toBe(true);
      expect(isFieldSensitive('Full Name', 'text')).toBe(false);

      const payload: AutosaveFieldPayload = {
        editingSessionId: 'sess-f2',
        hostname: 'apply.example.org',
        pageTitle: 'Apply',
        pageUrl: 'https://apply.example.org/',
        field: {
          label: 'Master Password',
          value: 'secret123',
          fieldType: 'password',
        },
      };

      const res = await handleAutosaveMessage(payload, repo);
      expect(res.status).toBe('skipped');
    });
  });

  describe('Scenario G: Blank current value does not erase historical answer', () => {
    it('preserves saved value when user temporarily clears field', async () => {
      const existingSub: Submission = {
        id: 'sub-hist-1',
        schemaVersion: SCHEMA_VERSION,
        createdAt: '2026-03-01T10:00:00.000Z',
        updatedAt: '2026-03-01T10:00:00.000Z',
        pageTitle: 'Job Application',
        pageUrl: 'https://jobs.example.com/apply',
        hostname: 'jobs.example.com',
        submissionTitle: 'Job Application',
        fields: [
          {
            id: 'f1',
            label: 'LinkedIn Profile',
            value: 'https://linkedin.com/in/adalovelace',
            fieldType: 'url',
            labelSource: 'label-for',
            excluded: false,
          },
        ],
        captureVersion: '0.1.0',
        revisions: [],
      };

      await repo.save(existingSub);

      const blankPayload: AutosaveFieldPayload = {
        editingSessionId: 'session-g',
        hostname: 'jobs.example.com',
        pageTitle: 'Job Application',
        pageUrl: 'https://jobs.example.com/apply',
        matchingSubmissionId: 'sub-hist-1',
        field: {
          label: 'LinkedIn Profile',
          value: '',
          fieldType: 'url',
        },
      };

      const res = await handleAutosaveMessage(blankPayload, repo);
      expect(res.status).toBe('unchanged');

      const retrieved = await repo.getById('sub-hist-1');
      expect(retrieved?.fields[0]?.value).toBe('https://linkedin.com/in/adalovelace');
    });
  });

  describe('Scenario H: Five field edits produce ONE logical record', () => {
    it('merges 5 sequential field edits into a single submission', async () => {
      const sessionId = 'session-h';
      const fieldsToEdit = [
        { label: 'Full Name', value: 'Charles Babbage', fieldType: 'text' },
        { label: 'Email', value: 'charles@example.org', fieldType: 'email' },
        { label: 'Role', value: 'Chief Architect', fieldType: 'text' },
        { label: 'Company', value: 'Analytical Engine Corp', fieldType: 'text' },
        { label: 'Location', value: 'London, UK', fieldType: 'text' },
      ];

      let trackedSubmissionId: string | undefined = undefined;

      for (const f of fieldsToEdit) {
        const payload: AutosaveFieldPayload = {
          editingSessionId: sessionId,
          formFingerprint: 'fp-london-form-123',
          hostname: 'london.example.org',
          pageTitle: 'Grant Form',
          pageUrl: 'https://london.example.org/apply',
          matchingSubmissionId: trackedSubmissionId,
          field: f,
          allCurrentFields: fieldsToEdit.map((item) => ({
            label: item.label,
            fieldType: item.fieldType,
          })),
        };

        const res = await handleAutosaveMessage(payload, repo);
        expect(res.status).toBe('saved');
        if (res.submissionId) {
          trackedSubmissionId = res.submissionId;
        }
      }

      // Check DB records
      const all = await repo.getAll();
      const londonSubs = all.filter((s) => s.hostname === 'london.example.org');
      expect(londonSubs).toHaveLength(1);
      expect(londonSubs[0]?.fields).toHaveLength(5);
      expect(londonSubs[0]?.fields.map((f) => f.label)).toEqual([
        'Full Name',
        'Email',
        'Role',
        'Company',
        'Location',
      ]);
    });
  });

  describe('Scenario I: Five edits in SAME session do NOT produce five revisions', () => {
    it('snapshots pre-edit state once per editingSessionId', async () => {
      const sessionId = 'session-i';
      const initialSub: Submission = {
        id: 'sub-i-1',
        schemaVersion: SCHEMA_VERSION,
        createdAt: '2026-03-01T10:00:00.000Z',
        updatedAt: '2026-03-01T10:00:00.000Z',
        pageTitle: 'Form',
        pageUrl: 'https://test.example.com/',
        hostname: 'test.example.com',
        submissionTitle: 'Test Form',
        fields: [
          {
            id: 'f1',
            label: 'Field 1',
            value: 'Initial 1',
            fieldType: 'text',
            labelSource: 'label-for',
            excluded: false,
          },
          {
            id: 'f2',
            label: 'Field 2',
            value: 'Initial 2',
            fieldType: 'text',
            labelSource: 'label-for',
            excluded: false,
          },
        ],
        captureVersion: '0.1.0',
        revisions: [],
      };

      await repo.save(initialSub);

      // Perform 5 field updates within the same editingSessionId
      for (let i = 1; i <= 5; i++) {
        await handleAutosaveMessage(
          {
            editingSessionId: sessionId,
            matchingSubmissionId: 'sub-i-1',
            hostname: 'test.example.com',
            pageTitle: 'Form',
            pageUrl: 'https://test.example.com/',
            field: {
              label: 'Field 1',
              value: `Updated 1 (v${i})`,
              fieldType: 'text',
            },
          },
          repo,
        );
      }

      const sub = await repo.getById('sub-i-1');
      expect(sub?.fields.find((f) => f.label === 'Field 1')?.value).toBe('Updated 1 (v5)');
      // Revisions should have exactly 1 pre-edit snapshot from this session
      expect(sub?.revisions).toHaveLength(1);
      expect(sub?.revisions?.[0]?.fields.find((f) => f.label === 'Field 1')?.value).toBe(
        'Initial 1',
      );
    });
  });

  describe('Scenario J: New editing session preserves prior state as one revision', () => {
    it('creates a new revision checkpoint when editingSessionId changes', async () => {
      const subId = 'sub-j-1';
      const initialSub: Submission = {
        id: subId,
        schemaVersion: SCHEMA_VERSION,
        createdAt: '2026-03-01T10:00:00.000Z',
        updatedAt: '2026-03-01T10:00:00.000Z',
        pageTitle: 'Form',
        pageUrl: 'https://j.example.com/',
        hostname: 'j.example.com',
        submissionTitle: 'Session Test',
        fields: [
          {
            id: 'f1',
            label: 'City',
            value: 'Paris',
            fieldType: 'text',
            labelSource: 'label-for',
            excluded: false,
          },
        ],
        captureVersion: '0.1.0',
        revisions: [],
        lastEditingSessionId: 'session-1',
      };
      await repo.save(initialSub);

      // Edit in session-1
      await handleAutosaveMessage(
        {
          editingSessionId: 'session-1',
          matchingSubmissionId: subId,
          hostname: 'j.example.com',
          pageTitle: 'Form',
          pageUrl: 'https://j.example.com/',
          field: { label: 'City', value: 'Lyon', fieldType: 'text' },
        },
        repo,
      );

      let sub = await repo.getById(subId);
      expect(sub?.fields[0]?.value).toBe('Lyon');
      expect(sub?.revisions).toHaveLength(0); // already had session-1 as lastEditingSessionId

      // Now start session-2
      await handleAutosaveMessage(
        {
          editingSessionId: 'session-2',
          matchingSubmissionId: subId,
          hostname: 'j.example.com',
          pageTitle: 'Form',
          pageUrl: 'https://j.example.com/',
          field: { label: 'City', value: 'Marseille', fieldType: 'text' },
        },
        repo,
      );

      sub = await repo.getById(subId);
      expect(sub?.fields[0]?.value).toBe('Marseille');
      // Should now have 1 revision snapshot with value 'Lyon'
      expect(sub?.revisions).toHaveLength(1);
      expect(sub?.revisions?.[0]?.fields[0]?.value).toBe('Lyon');

      // Another edit in session-2 does not add another revision
      await handleAutosaveMessage(
        {
          editingSessionId: 'session-2',
          matchingSubmissionId: subId,
          hostname: 'j.example.com',
          pageTitle: 'Form',
          pageUrl: 'https://j.example.com/',
          field: { label: 'City', value: 'Nice', fieldType: 'text' },
        },
        repo,
      );

      sub = await repo.getById(subId);
      expect(sub?.fields[0]?.value).toBe('Nice');
      expect(sub?.revisions).toHaveLength(1);
    });
  });

  describe('Scenario K: Identical value does not perform redundant write', () => {
    it('returns status unchanged and does not update updatedAt', async () => {
      const subId = 'sub-k-1';
      const timestamp = '2026-03-01T10:00:00.000Z';
      const sub: Submission = {
        id: subId,
        schemaVersion: SCHEMA_VERSION,
        createdAt: timestamp,
        updatedAt: timestamp,
        pageTitle: 'Form',
        pageUrl: 'https://k.example.com/',
        hostname: 'k.example.com',
        submissionTitle: 'K Test',
        fields: [
          {
            id: 'f1',
            label: 'Company',
            value: 'Open Source Labs',
            fieldType: 'text',
            labelSource: 'label-for',
            excluded: false,
          },
        ],
        captureVersion: '0.1.0',
        revisions: [],
      };
      await repo.save(sub);

      const res = await handleAutosaveMessage(
        {
          editingSessionId: 'session-k',
          matchingSubmissionId: subId,
          hostname: 'k.example.com',
          pageTitle: 'Form',
          pageUrl: 'https://k.example.com/',
          field: {
            label: 'Company',
            value: 'Open Source Labs',
            fieldType: 'text',
          },
        },
        repo,
      );

      expect(res.status).toBe('unchanged');
      const retrieved = await repo.getById(subId);
      expect(retrieved?.updatedAt).toBe(timestamp);
    });
  });

  describe('Scenario L: Autofill-generated events do not trigger autosave', () => {
    it('suppresses autosave when __submitlog_suppress_autosave is true', () => {
      const messages = setupMockChrome();

      document.body.innerHTML = `
        <form>
          <label for="name">Name</label>
          <input id="name" type="text" value="Auto Filled Name" />
        </form>
      `;

      injectedArmAutosave({
        editingSessionId: 'session-l',
        hostname: 'example.com',
        pageTitle: 'Page',
        pageUrl: 'https://example.com/',
        initialFields: [{ label: 'Name', fieldType: 'text' }],
      });

      // Simulate programmatic fill setting suppression
      window.__submitlog_suppress_autosave = true;

      const input = document.getElementById('name') as HTMLInputElement;
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));

      vi.advanceTimersByTime(500);

      expect(messages).toHaveLength(0);
    });
  });

  describe('Scenario M: Popup may close and background autosave still works', () => {
    it('processes and persists autosave messages independently of popup', async () => {
      const payload: AutosaveFieldPayload = {
        editingSessionId: 'sess-background',
        hostname: 'indep.example.com',
        pageTitle: 'Independent Test',
        pageUrl: 'https://indep.example.com/apply',
        field: {
          label: 'Specialty',
          value: 'Cryptography',
          fieldType: 'text',
        },
      };

      const res = await handleAutosaveMessage(payload, repo);
      expect(res.status).toBe('saved');
      expect(res.submissionId).toBeDefined();

      const saved = await repo.getById(res.submissionId!);
      expect(saved?.fields[0]?.value).toBe('Cryptography');
    });
  });

  describe('Scenario N: First autosaved field on blank form creates draft record', () => {
    it('creates a new draft submission with isDraft: true', async () => {
      const payload: AutosaveFieldPayload = {
        editingSessionId: 'sess-draft-first',
        hostname: 'newform.example.com',
        pageTitle: 'Blank Application',
        pageUrl: 'https://newform.example.com/form',
        field: {
          label: 'Applicant Name',
          value: 'Alan Turing',
          fieldType: 'text',
        },
        allCurrentFields: [
          { label: 'Applicant Name', fieldType: 'text' },
          { label: 'Project Concept', fieldType: 'textarea' },
        ],
      };

      const res = await handleAutosaveMessage(payload, repo);
      expect(res.status).toBe('saved');
      expect(res.submissionId).toBeDefined();

      const created = await repo.getById(res.submissionId!);
      expect(created).toBeDefined();
      expect(created?.isDraft).toBe(true);
      expect(created?.fields).toHaveLength(1);
      expect(created?.fields[0]?.label).toBe('Applicant Name');
      expect(created?.fields[0]?.value).toBe('Alan Turing');
      expect(created?.revisions).toHaveLength(1);
      expect(created?.revisions?.[0]?.changeNote).toBe('Initial draft autosave');
    });
  });

  describe('Scenario O: Subsequent fields merge into that draft', () => {
    it('merges subsequent edits into existing draft by session/fingerprint', async () => {
      const sessionId = 'sess-draft-merge';
      const fp = 'fp-draft-test-777';

      // 1. First field
      const res1 = await handleAutosaveMessage(
        {
          editingSessionId: sessionId,
          formFingerprint: fp,
          hostname: 'draftmerge.example.com',
          pageTitle: 'Draft Merge',
          pageUrl: 'https://draftmerge.example.com/',
          field: { label: 'Field A', value: 'Value A', fieldType: 'text' },
          allCurrentFields: [
            { label: 'Field A', fieldType: 'text' },
            { label: 'Field B', fieldType: 'text' },
          ],
        },
        repo,
      );

      expect(res1.status).toBe('saved');
      const draftId = res1.submissionId!;

      // 2. Second field without matchingSubmissionId provided initially
      const res2 = await handleAutosaveMessage(
        {
          editingSessionId: sessionId,
          formFingerprint: fp,
          hostname: 'draftmerge.example.com',
          pageTitle: 'Draft Merge',
          pageUrl: 'https://draftmerge.example.com/',
          field: { label: 'Field B', value: 'Value B', fieldType: 'text' },
          allCurrentFields: [
            { label: 'Field A', fieldType: 'text' },
            { label: 'Field B', fieldType: 'text' },
          ],
        },
        repo,
      );

      expect(res2.status).toBe('saved');
      expect(res2.submissionId).toBe(draftId);

      const all = await repo.getAll();
      const subs = all.filter((s) => s.hostname === 'draftmerge.example.com');
      expect(subs).toHaveLength(1);
      expect(subs[0]?.id).toBe(draftId);
      expect(subs[0]?.fields).toHaveLength(2);
    });
  });

  describe('Scenario P: Native submit flushes pending debounced autosave', () => {
    it('flushes pending changes immediately on submit without preventing default', () => {
      const messages = setupMockChrome();

      document.body.innerHTML = `
        <form id="testForm">
          <label for="answer">Answer</label>
          <input id="answer" type="text" value="Final Answer" />
          <button type="submit" id="submitBtn">Submit</button>
        </form>
      `;

      injectedArmAutosave({
        editingSessionId: 'session-p',
        hostname: 'example.com',
        pageTitle: 'Form',
        pageUrl: 'https://example.com/',
        initialFields: [{ label: 'Answer', fieldType: 'text' }],
      });

      const input = document.getElementById('answer') as HTMLInputElement;
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));

      // Before timer expires (0ms), submit is triggered
      expect(messages).toHaveLength(0);

      const form = document.getElementById('testForm') as HTMLFormElement;
      const submitEvent = new Event('submit', { bubbles: true, cancelable: true });
      const notPrevented = form.dispatchEvent(submitEvent);

      // Event must NOT be prevented
      expect(notPrevented).toBe(true);
      expect(submitEvent.defaultPrevented).toBe(false);

      // Pending message must be immediately flushed
      expect(messages).toHaveLength(1);
      expect(messages[0]?.payload.field.value).toBe('Final Answer');
    });
  });

  describe('Autosave status and disarm', () => {
    it('reports correct status and disarms listeners cleanly', () => {
      expect(injectedGetAutosaveStatus().active).toBe(false);

      injectedArmAutosave({
        editingSessionId: 'session-q',
        hostname: 'example.com',
        pageTitle: 'Test',
        pageUrl: 'https://example.com/',
        initialFields: [],
      });

      const status = injectedGetAutosaveStatus();
      expect(status.active).toBe(true);
      expect(status.editingSessionId).toBe('session-q');

      injectedDisarmAutosave();

      expect(injectedGetAutosaveStatus().active).toBe(false);
    });
  });
});
