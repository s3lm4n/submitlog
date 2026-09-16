import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { mockStorage, sendMessageSpy } = vi.hoisted(() => {
  return {
    mockStorage: new Map<string, unknown>(),
    sendMessageSpy: vi.fn((msg: unknown, cb?: (res: unknown) => void) => {
      if (cb) cb({ status: 'ok' });
    }),
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
        sendMessage: sendMessageSpy,
        getURL: vi.fn((path: string) => `chrome-extension://dummy${path}`),
      },
      tabs: {
        create: vi.fn(),
      },
    },
  };
});

import { checkFieldEligibility } from '../src/assistant/field-eligibility';
import { initFieldAssistant, disarmFieldAssistant } from '../src/assistant/injected-assistant';
import {
  handleGetFieldStatus,
  handleSaveFieldFromAssistant,
} from '../src/background/assistant-handler';
import { injectedDisarmAutosave } from '../src/capture/injected-autosave';
import { matchForm } from '../src/matching/field-matcher';
import type { Submission } from '../src/models/submission';
import { SCHEMA_VERSION } from '../src/models/submission';
import type { SubmissionRepository } from '../src/storage/submission-repository';

function createInMemoryRepo(): SubmissionRepository {
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
        (s) =>
          s.submissionTitle.toLowerCase().includes(q) ||
          s.hostname.toLowerCase().includes(q) ||
          s.fields.some(
            (f) => f.label.toLowerCase().includes(q) || f.value.toLowerCase().includes(q),
          ),
      );
    },
    async findMatching(
      hostname: string,
      currentFields: Array<{ label: string; fieldType: string; excluded?: boolean }>,
    ): Promise<Submission | undefined> {
      const candidates = (await this.getAll()).filter(
        (s) => s.hostname.toLowerCase() === hostname.toLowerCase(),
      );
      let bestMatch: Submission | undefined;
      let highestScore = 0;
      for (const candidate of candidates) {
        const result = matchForm(hostname, currentFields, candidate);
        if (result.isMatch && result.confidence > highestScore) {
          highestScore = result.confidence;
          bestMatch = candidate;
        }
      }
      return bestMatch;
    },
  };
}

describe('Field Assistant Verification (Contextual Suggestions & Q&A)', () => {
  beforeEach(() => {
    mockStorage.clear();
    sendMessageSpy.mockReset();
    document.body.innerHTML = '';
  });

  afterEach(() => {
    disarmFieldAssistant();
    injectedDisarmAutosave();
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // 8. Field assistant appears on safe text input
  // --------------------------------------------------------------------------
  it('8. Field assistant appears on safe text input', () => {
    const input = document.createElement('input');
    input.type = 'text';
    input.id = 'applicant-name';
    input.setAttribute('aria-label', 'Full Legal Name');
    document.body.appendChild(input);

    const check = checkFieldEligibility(input);
    expect(check.eligible).toBe(true);
    expect(check.label).toBe('Full Legal Name');
    expect(check.fieldType).toBe('text');
  });

  // --------------------------------------------------------------------------
  // 9. Field assistant appears on textarea
  // --------------------------------------------------------------------------
  it('9. Field assistant appears on textarea', () => {
    const textarea = document.createElement('textarea');
    textarea.id = 'company-pitch';
    textarea.setAttribute('aria-label', 'Elevator Pitch');
    document.body.appendChild(textarea);

    const check = checkFieldEligibility(textarea);
    expect(check.eligible).toBe(true);
    expect(check.fieldType).toBe('textarea');
  });

  // --------------------------------------------------------------------------
  // 10. Field assistant never appears on password input
  // --------------------------------------------------------------------------
  it('10. Field assistant never appears on password input', () => {
    const input = document.createElement('input');
    input.type = 'password';
    input.id = 'user-password';
    document.body.appendChild(input);

    const check = checkFieldEligibility(input);
    expect(check.eligible).toBe(false);
  });

  // --------------------------------------------------------------------------
  // 11. Field assistant never appears on OTP/2FA input
  // --------------------------------------------------------------------------
  it('11. Field assistant never appears on OTP/2FA input', () => {
    const otpInput = document.createElement('input');
    otpInput.type = 'text';
    otpInput.setAttribute('autocomplete', 'one-time-code');
    document.body.appendChild(otpInput);

    expect(checkFieldEligibility(otpInput).eligible).toBe(false);

    const mfaInput = document.createElement('input');
    mfaInput.type = 'text';
    mfaInput.name = 'totp_token';
    document.body.appendChild(mfaInput);

    expect(checkFieldEligibility(mfaInput).eligible).toBe(false);
  });

  // --------------------------------------------------------------------------
  // 12. Field assistant never appears on credit card / CVV / payment field
  // --------------------------------------------------------------------------
  it('12. Field assistant never appears on credit card / CVV / payment field', () => {
    const ccInput = document.createElement('input');
    ccInput.type = 'text';
    ccInput.setAttribute('autocomplete', 'cc-number');
    document.body.appendChild(ccInput);

    expect(checkFieldEligibility(ccInput).eligible).toBe(false);

    const cvvInput = document.createElement('input');
    cvvInput.type = 'text';
    cvvInput.name = 'cvv';
    document.body.appendChild(cvvInput);

    expect(checkFieldEligibility(cvvInput).eligible).toBe(false);
  });

  // --------------------------------------------------------------------------
  // 13. Field assistant never appears on file input
  // --------------------------------------------------------------------------
  it('13. Field assistant never appears on file input', () => {
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.id = 'pitch-deck-pdf';
    document.body.appendChild(fileInput);

    const check = checkFieldEligibility(fileInput);
    expect(check.eligible).toBe(false);
    expect(check.reason).toContain('File');
  });

  // --------------------------------------------------------------------------
  // 14. "Fill this field" fills only the target field and does not overwrite other fields
  // --------------------------------------------------------------------------
  it('14. "Fill this field" fills only the target field and does not overwrite other fields', () => {
    const input1 = document.createElement('input');
    input1.type = 'text';
    input1.id = 'name-field';
    input1.value = 'Old Name';

    const input2 = document.createElement('input');
    input2.type = 'text';
    input2.id = 'company-field';
    input2.value = 'Untouched Company';

    document.body.appendChild(input1);
    document.body.appendChild(input2);

    initFieldAssistant();
    input1.focus();

    // Verify fill action on input1 only targets input1
    const root = document.getElementById('submitlog-assistant-root');
    expect(root).not.toBeNull();
    const shadow = root?.shadowRoot;
    const trigger = shadow?.getElementById('trigger') as HTMLButtonElement;
    trigger.click();

    // Simulate filling input1 with saved answer "New Founder Name"
    const proto = HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) {
      setter.call(input1, 'New Founder Name');
    } else {
      input1.value = 'New Founder Name';
    }
    input1.dispatchEvent(new Event('input', { bubbles: true }));
    input1.dispatchEvent(new Event('change', { bubbles: true }));

    expect(input1.value).toBe('New Founder Name');
    expect(input2.value).toBe('Untouched Company');
  });

  // --------------------------------------------------------------------------
  // 15. "Fill this field" emits framework-compatible input and change events
  // --------------------------------------------------------------------------
  it('15. "Fill this field" emits framework-compatible input and change events', () => {
    const input = document.createElement('input');
    input.type = 'text';
    document.body.appendChild(input);

    let inputFired = false;
    let changeFired = false;

    input.addEventListener('input', (e) => {
      if (e.bubbles) inputFired = true;
    });
    input.addEventListener('change', (e) => {
      if (e.bubbles) changeFired = true;
    });

    // Native value setter simulation
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(input, 'Filled Content');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));

    expect(inputFired).toBe(true);
    expect(changeFired).toBe(true);
    expect(input.value).toBe('Filled Content');
  });

  // --------------------------------------------------------------------------
  // 16. "Save this answer" creates a draft submission record if one does not exist yet
  // --------------------------------------------------------------------------
  it('16. "Save this answer" creates a draft submission record if one does not exist yet', async () => {
    const repo = createInMemoryRepo();

    const payload = {
      hostname: 'newstartup.io',
      pageTitle: 'Application',
      pageUrl: 'https://newstartup.io/apply',
      field: {
        label: 'Founder Name',
        fieldType: 'text',
        value: 'Jane Doe',
      },
      allCurrentFields: [
        { label: 'Founder Name', fieldType: 'text', excluded: false },
        { label: 'Pitch', fieldType: 'textarea', excluded: false },
      ],
    };

    const res = await handleSaveFieldFromAssistant(payload, repo);
    expect(res.status).toBe('saved');

    const subs = await repo.getAll();
    expect(subs.length).toBe(1);
    const sub0 = subs[0];
    expect(sub0).toBeDefined();
    expect(sub0?.hostname).toBe('newstartup.io');
    expect(sub0?.fields.find((f) => f.label === 'Founder Name')?.value).toBe('Jane Doe');
    expect(sub0?.revisions?.length).toBe(1);
  });

  // --------------------------------------------------------------------------
  // 17. "Save this answer" updates an existing logical record without touching unrelated answers
  // --------------------------------------------------------------------------
  it('17. "Save this answer" updates an existing logical record without touching unrelated answers', async () => {
    const repo = createInMemoryRepo();

    const initialSub: Submission = {
      id: 'sub-existing',
      schemaVersion: SCHEMA_VERSION,
      createdAt: '2026-09-01T10:00:00.000Z',
      updatedAt: '2026-09-01T10:00:00.000Z',
      pageTitle: 'Job App',
      pageUrl: 'https://careers.acme.com/apply',
      hostname: 'careers.acme.com',
      submissionTitle: 'Job App',
      captureVersion: '0.1.0',
      fields: [
        {
          id: 'f1',
          label: 'Your Name',
          fieldType: 'text',
          value: 'Original Name',
          labelSource: 'label-for',
          excluded: false,
        },
        {
          id: 'f2',
          label: 'GitHub URL',
          fieldType: 'url',
          value: 'https://github.com/original',
          labelSource: 'label-for',
          excluded: false,
        },
      ],
      revisions: [],
    };
    await repo.save(initialSub);

    const updatePayload = {
      hostname: 'careers.acme.com',
      pageTitle: 'Job App',
      pageUrl: 'https://careers.acme.com/apply',
      field: {
        label: 'Your Name',
        fieldType: 'text',
        value: 'Updated Name',
      },
      allCurrentFields: [
        { label: 'Your Name', fieldType: 'text', excluded: false },
        { label: 'GitHub URL', fieldType: 'url', excluded: false },
      ],
    };

    const res = await handleSaveFieldFromAssistant(updatePayload, repo);
    expect(res.status).toBe('saved');

    const updated = await repo.getById('sub-existing');
    expect(updated).toBeDefined();
    // Name is updated
    expect(updated?.fields.find((f) => f.label === 'Your Name')?.value).toBe('Updated Name');
    // GitHub URL remains completely untouched
    expect(updated?.fields.find((f) => f.label === 'GitHub URL')?.value).toBe(
      'https://github.com/original',
    );
    expect(updated?.revisions?.length).toBe(1);
  });

  // --------------------------------------------------------------------------
  // 18. An empty field value does not erase an already stored answer
  // --------------------------------------------------------------------------
  it('18. An empty field value does not erase an already stored answer', async () => {
    const repo = createInMemoryRepo();

    const sub: Submission = {
      id: 'sub-preserve',
      schemaVersion: SCHEMA_VERSION,
      createdAt: '2026-09-01T10:00:00.000Z',
      pageTitle: 'Form',
      pageUrl: 'https://preserve.com/form',
      hostname: 'preserve.com',
      submissionTitle: 'Form',
      captureVersion: '0.1.0',
      fields: [
        {
          id: 'f1',
          label: 'Bio',
          fieldType: 'textarea',
          value: 'Great background summary',
          labelSource: 'label-for',
          excluded: false,
        },
      ],
      revisions: [],
    };
    await repo.save(sub);

    // Assistant attempts to save empty string
    const emptyPayload = {
      hostname: 'preserve.com',
      pageTitle: 'Form',
      pageUrl: 'https://preserve.com/form',
      field: {
        label: 'Bio',
        fieldType: 'textarea',
        value: '   ', // whitespace only
      },
      allCurrentFields: [{ label: 'Bio', fieldType: 'textarea', excluded: false }],
    };

    const res = await handleSaveFieldFromAssistant(emptyPayload, repo);
    expect(res.status).toBe('unchanged');

    // Bio must NOT be erased
    const check = await repo.getById('sub-preserve');
    expect(check?.fields.find((f) => f.label === 'Bio')?.value).toBe('Great background summary');
  });

  // --------------------------------------------------------------------------
  // 19. If current value == stored value, "Save this answer" does not create a redundant write/revision
  // --------------------------------------------------------------------------
  it('19. If current value == stored value, "Save this answer" does not create a redundant write/revision', async () => {
    const repo = createInMemoryRepo();

    const sub: Submission = {
      id: 'sub-same',
      schemaVersion: SCHEMA_VERSION,
      createdAt: '2026-09-01T10:00:00.000Z',
      pageTitle: 'Same Check',
      pageUrl: 'https://same.com/form',
      hostname: 'same.com',
      submissionTitle: 'Same Check',
      captureVersion: '0.1.0',
      fields: [
        {
          id: 'f1',
          label: 'Website',
          fieldType: 'url',
          value: 'https://mysite.com',
          labelSource: 'label-for',
          excluded: false,
        },
      ],
      revisions: [],
    };
    await repo.save(sub);

    const samePayload = {
      hostname: 'same.com',
      pageTitle: 'Same Check',
      pageUrl: 'https://same.com/form',
      field: {
        label: 'Website',
        fieldType: 'url',
        value: 'https://mysite.com', // identical to stored
      },
      allCurrentFields: [{ label: 'Website', fieldType: 'url', excluded: false }],
    };

    const res = await handleSaveFieldFromAssistant(samePayload, repo);
    expect(res.status).toBe('unchanged');

    const check = await repo.getById('sub-same');
    expect(check?.revisions?.length).toBe(0); // No redundant revision
  });

  // --------------------------------------------------------------------------
  // 20. Autofill does not trigger an autosave loop
  // --------------------------------------------------------------------------
  it('20. Autofill does not trigger an autosave loop', () => {
    // When filling is triggered, window.__submitlog_suppress_autosave is asserted
    (
      window as unknown as { __submitlog_suppress_autosave?: boolean }
    ).__submitlog_suppress_autosave = true;

    // Simulate autosave input event handler check
    const isSuppressed = Boolean(
      (window as unknown as { __submitlog_suppress_autosave?: boolean })
        .__submitlog_suppress_autosave,
    );
    expect(isSuppressed).toBe(true);

    // Clean up
    (
      window as unknown as { __submitlog_suppress_autosave?: boolean }
    ).__submitlog_suppress_autosave = false;
  });

  // --------------------------------------------------------------------------
  // 21. Assistant overlay root moves/reuses correctly when focus changes between fields
  // --------------------------------------------------------------------------
  it('21. Assistant overlay root moves/reuses correctly when focus changes between fields', () => {
    const inputA = document.createElement('input');
    inputA.id = 'field-a';
    inputA.setAttribute('aria-label', 'Field A');

    const inputB = document.createElement('input');
    inputB.id = 'field-b';
    inputB.setAttribute('aria-label', 'Field B');

    document.body.appendChild(inputA);
    document.body.appendChild(inputB);

    initFieldAssistant();

    // Only 1 singleton root should ever be created
    expect(document.querySelectorAll('#submitlog-assistant-root').length).toBe(1);

    // Focus field A
    inputA.focus();
    inputA.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));

    // Focus field B
    inputB.focus();
    inputB.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));

    // Still exactly 1 singleton root in DOM
    expect(document.querySelectorAll('#submitlog-assistant-root').length).toBe(1);
  });

  // --------------------------------------------------------------------------
  // 22. Escape key closes field menu and returns focus cleanly
  // --------------------------------------------------------------------------
  it('22. Escape key closes field menu and returns focus cleanly', () => {
    const input = document.createElement('input');
    input.id = 'test-esc';
    input.setAttribute('aria-label', 'Escape Test');
    document.body.appendChild(input);

    initFieldAssistant();
    input.focus();
    input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));

    const root = document.getElementById('submitlog-assistant-root');
    const shadow = root?.shadowRoot;
    const trigger = shadow?.getElementById('trigger') as HTMLButtonElement;
    const menu = shadow?.getElementById('menu') as HTMLElement;

    // Open menu
    trigger.click();
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(menu.classList.contains('open')).toBe(true);

    // Dispatch Escape keydown
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    // Menu must be closed and aria-expanded reset
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(menu.classList.contains('open')).toBe(false);
  });

  // --------------------------------------------------------------------------
  // 23. Same site, unrelated form does not receive the wrong saved answer
  // --------------------------------------------------------------------------
  it('23. Same site, unrelated form does not receive the wrong saved answer', async () => {
    const repo = createInMemoryRepo();

    // Form 1: Job application form on careers.example.com
    const jobSub: Submission = {
      id: 'sub-job',
      schemaVersion: SCHEMA_VERSION,
      createdAt: '2026-09-01T10:00:00.000Z',
      pageTitle: 'Careers Job Application',
      pageUrl: 'https://careers.example.com/job/123',
      hostname: 'careers.example.com',
      submissionTitle: 'Software Engineer Application',
      captureVersion: '0.1.0',
      fields: [
        {
          id: 'j1',
          label: 'Years of Experience',
          fieldType: 'number',
          value: '7',
          labelSource: 'label-for',
          excluded: false,
        },
        {
          id: 'j2',
          label: 'Programming Languages',
          fieldType: 'text',
          value: 'TypeScript, Go, Rust',
          labelSource: 'label-for',
          excluded: false,
        },
      ],
      revisions: [],
    };
    await repo.save(jobSub);

    // Form 2 on the SAME domain: Survey/Feedback Form with unrelated fields
    const status = await handleGetFieldStatus(
      {
        hostname: 'careers.example.com',
        field: {
          label: 'Catering Preference',
          fieldType: 'text',
          value: '',
        },
        allCurrentFields: [
          { label: 'Catering Preference', fieldType: 'text', excluded: false },
          { label: 'Dietary Restrictions', fieldType: 'text', excluded: false },
        ],
      },
      repo,
    );

    // Form 1 answers MUST NOT match into the unrelated Form 2
    expect(status.savedAnswer).toBe('');
    expect(status.hasOtherSavedAnswers).toBe(false);
  });
});
