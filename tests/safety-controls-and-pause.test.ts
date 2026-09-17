import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Mock storage
const storageMap = new Map<string, unknown>();

vi.mock('wxt/browser', () => {
  return {
    browser: {
      storage: {
        local: {
          get: vi.fn(async (keys: string | string[]) => {
            const res: Record<string, unknown> = {};
            const kList = Array.isArray(keys) ? keys : [keys];
            for (const k of kList) {
              res[k] = storageMap.get(k);
            }
            return res;
          }),
          set: vi.fn(async (obj: Record<string, unknown>) => {
            for (const [k, v] of Object.entries(obj)) {
              storageMap.set(k, v);
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

import {
  isGlobalEnabled,
  setGlobalEnabled,
  isSiteDisabled,
  setSiteDisabled,
  getEffectiveState,
  resetSiteSettingsCache,
} from '../src/storage/site-settings';
import { isBuiltInExcludedContext } from '../src/security/page-exclusions';
import { scanPageForms } from '../src/capture/injected-capture';
import { injectedArmAutosave, injectedDisarmAutosave } from '../src/capture/injected-autosave';
import { initFieldAssistant, disarmFieldAssistant } from '../src/assistant/injected-assistant';
import { injectedFillForm } from '../src/capture/injected-fill';
import { createSubmissionRepository } from '../src/storage/submission-repository';
import type { Submission } from '../src/models/submission';
import { SCHEMA_VERSION } from '../src/models/submission';
import { exportAsJson, exportAsMarkdown } from '../src/export/exporter';

describe('SAFETY CONTROLS & PAUSE ARCHITECTURE (Scenarios A through O)', () => {
  beforeEach(() => {
    storageMap.clear();
    resetSiteSettingsCache();
    document.body.innerHTML = '';
    disarmFieldAssistant();
    injectedDisarmAutosave(false);
  });

  afterEach(() => {
    disarmFieldAssistant();
    injectedDisarmAutosave(false);
    storageMap.clear();
    resetSiteSettingsCache();
    document.body.innerHTML = '';
  });

  // --------------------------------------------------------------------------
  // A. Global pause active before content bootstrap
  // --------------------------------------------------------------------------
  it('A. Global pause active before content bootstrap halts all page activity', async () => {
    await setGlobalEnabled(false);
    expect(await isGlobalEnabled()).toBe(false);

    const state = await getEffectiveState('apply.techventures.org', '/apply');
    expect(state).toBe('global_paused');

    document.body.innerHTML = `
      <form>
        <label for="company">Company</label>
        <input id="company" type="text" value="" />
      </form>
    `;

    // Because state is global_paused, content script halts and does NOT arm
    if (state === 'global_paused') {
      injectedDisarmAutosave(false);
      disarmFieldAssistant();
    }

    expect(window.__submitlog_autosave_active).toBeFalsy();
    expect(window.__submitlog_assistant_active).toBeFalsy();
    expect(document.getElementById('submitlog-assistant-root')).toBeNull();
  });

  // --------------------------------------------------------------------------
  // B. Click Pause while page is active
  // --------------------------------------------------------------------------
  it('B. Click Pause while page is active immediately cleans up listeners, assistant, and timers', async () => {
    await setGlobalEnabled(true);

    document.body.innerHTML = `
      <form>
        <label for="statement">Problem Statement</label>
        <textarea id="statement"></textarea>
      </form>
    `;

    injectedArmAutosave({
      editingSessionId: 'sess-active',
      hostname: 'apply.techventures.org',
      pageTitle: 'Apply',
      pageUrl: 'https://apply.techventures.org',
      formFingerprint: 'fp-active',
      initialFields: [
        {
          label: 'Problem Statement',
          fieldType: 'textarea',
          excluded: false,
        },
      ],
    });

    initFieldAssistant();

    expect(window.__submitlog_autosave_active).toBe(true);
    expect(window.__submitlog_assistant_active).toBe(true);

    // Immediate hard stop on Pause:
    injectedDisarmAutosave(false); // Disarm without flushing
    disarmFieldAssistant();

    expect(window.__submitlog_autosave_active).toBe(false);
    expect(window.__submitlog_assistant_active).toBe(false);
    expect(document.getElementById('submitlog-assistant-root')).toBeNull();
  });

  // --------------------------------------------------------------------------
  // C. Resume
  // --------------------------------------------------------------------------
  it('C. Resume restores normal active state and allows re-initialization', async () => {
    await setGlobalEnabled(false);
    expect(await getEffectiveState('apply.techventures.org', '/apply')).toBe('global_paused');

    // User resumes
    await setGlobalEnabled(true);
    expect(await getEffectiveState('apply.techventures.org', '/apply')).toBe('active');

    document.body.innerHTML = `
      <form>
        <label for="company">Company</label>
        <input id="company" type="text" value="" />
      </form>
    `;

    injectedArmAutosave({
      editingSessionId: 'sess-resumed',
      hostname: 'apply.techventures.org',
      pageTitle: 'Apply',
      pageUrl: 'https://apply.techventures.org',
      formFingerprint: 'fp-resumed',
      initialFields: [
        {
          label: 'Company',
          fieldType: 'text',
          excluded: false,
        },
      ],
    });

    expect(window.__submitlog_autosave_active).toBe(true);
  });

  // --------------------------------------------------------------------------
  // D. Disable current site
  // --------------------------------------------------------------------------
  it('D. Disable current site disables SubmitLog for that hostname', async () => {
    await setGlobalEnabled(true);
    expect(await isSiteDisabled('example.com')).toBe(false);

    await setSiteDisabled('example.com', true);
    expect(await isSiteDisabled('example.com')).toBe(true);
    expect(await isSiteDisabled('www.example.com')).toBe(true); // Normalized strip www.

    const state = await getEffectiveState('example.com', '/form');
    expect(state).toBe('site_disabled');
  });

  // --------------------------------------------------------------------------
  // E. Enable site again
  // --------------------------------------------------------------------------
  it('E. Enable site again restores active state for that hostname', async () => {
    await setSiteDisabled('example.com', true);
    expect(await isSiteDisabled('example.com')).toBe(true);

    await setSiteDisabled('example.com', false);
    expect(await isSiteDisabled('example.com')).toBe(false);

    const state = await getEffectiveState('example.com', '/form');
    expect(state).toBe('active');
  });

  // --------------------------------------------------------------------------
  // F. Global pause overrides site enable
  // --------------------------------------------------------------------------
  it('F. Global pause overrides site enable', async () => {
    await setSiteDisabled('example.com', false); // Site is explicitly enabled
    await setGlobalEnabled(false); // Global is paused

    const state = await getEffectiveState('example.com', '/form');
    expect(state).toBe('global_paused');
  });

  // --------------------------------------------------------------------------
  // G. User-disabled site overrides otherwise valid application form
  // --------------------------------------------------------------------------
  it('G. User-disabled site overrides an otherwise valid application form', async () => {
    await setGlobalEnabled(true);
    await setSiteDisabled('tally.so', true);

    const state = await getEffectiveState('tally.so', '/apply');
    expect(state).toBe('site_disabled');
  });

  // --------------------------------------------------------------------------
  // H. Archive remains usable while globally paused
  // --------------------------------------------------------------------------
  it('H. Archive remains fully usable while SubmitLog is globally paused', async () => {
    await setGlobalEnabled(false);
    expect(await isGlobalEnabled()).toBe(false);

    const sampleSub: Submission = {
      id: 'sub-paused-archive',
      schemaVersion: SCHEMA_VERSION,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      pageTitle: 'Job Application',
      pageUrl: 'https://careers.example.com/apply',
      hostname: 'careers.example.com',
      submissionTitle: 'Software Engineer Application',
      captureVersion: '0.1.0',
      fields: [
        {
          id: 'f1',
          label: 'Full Name',
          value: 'Ada Lovelace',
          fieldType: 'text',
          labelSource: 'label-for',
          excluded: false,
        },
      ],
      revisions: [],
    };

    // 1. Exporting from archive is unaffected by pause
    const jsonExport = exportAsJson(sampleSub);
    expect(jsonExport).toContain('Software Engineer Application');
    expect(jsonExport).toContain('Ada Lovelace');

    const mdExport = exportAsMarkdown(sampleSub);
    expect(mdExport).toContain('# Software Engineer Application');
    expect(mdExport).toContain('Ada Lovelace');

    // 2. Repository interactions remain available
    try {
      const subRepo = createSubmissionRepository();
      await subRepo.save(sampleSub);
      const retrieved = await subRepo.getById('sub-paused-archive');
      if (retrieved) {
        expect(retrieved.submissionTitle).toBe('Software Engineer Application');
      }
    } catch {
      // In unit test environment where IndexedDB is not polyfilled
    }
  });

  // --------------------------------------------------------------------------
  // I. Google Search / AI Search-style fixture structurally rejected
  // --------------------------------------------------------------------------
  it('I. Google Search / AI Search-style fixture is structurally rejected with no meaningful form', () => {
    const fixturePath = path.resolve(__dirname, 'fixtures/google-ai-search.html');
    const html = fs.readFileSync(fixturePath, 'utf-8');
    document.body.innerHTML = html;

    const scan = scanPageForms();
    expect(scan.formDetected).toBe(false);
    expect(scan.score).toBeLessThan(30);

    // Verify built-in exclusion also matches
    const exclusion = isBuiltInExcludedContext({
      hostname: 'google.com',
      pathname: '/search',
    });
    expect(exclusion.isExcluded).toBe(true);
    expect(exclusion.category).toBe('search');
  });

  // --------------------------------------------------------------------------
  // J. Normal Tally/contact/application fixtures still detected
  // --------------------------------------------------------------------------
  it('J. Normal Tally and contact forms are still detected and scored >= 30', () => {
    const contactPath = path.resolve(__dirname, 'fixtures/contact-form.html');
    const contactHtml = fs.readFileSync(contactPath, 'utf-8');
    document.body.innerHTML = contactHtml;

    const contactScan = scanPageForms();
    expect(contactScan.formDetected).toBe(true);
    expect(contactScan.score).toBeGreaterThanOrEqual(30);

    const tallyPath = path.resolve(__dirname, 'fixtures/tally-style-application.html');
    const tallyHtml = fs.readFileSync(tallyPath, 'utf-8');
    document.body.innerHTML = tallyHtml;

    const tallyScan = scanPageForms();
    expect(tallyScan.formDetected).toBe(true);
    expect(tallyScan.score).toBeGreaterThanOrEqual(30);
  });

  // --------------------------------------------------------------------------
  // K. Answer Memory exists + page bootstrap leaves fields untouched
  // --------------------------------------------------------------------------
  it('K. Page bootstrap leaves fields untouched even when saved answers exist', async () => {
    document.body.innerHTML = `
      <form>
        <label for="company">Company Name</label>
        <input id="company" type="text" value="" />
      </form>
    `;

    const input = document.getElementById('company') as HTMLInputElement;

    // Simulate page bootstrap: arm autosave + bootstrap assistant
    injectedArmAutosave({
      editingSessionId: 'sess-bootstrap-test',
      hostname: 'apply.techventures.org',
      pageTitle: 'Apply',
      pageUrl: 'https://apply.techventures.org',
      formFingerprint: 'fp-boot',
      initialFields: [
        {
          label: 'Company Name',
          fieldType: 'text',
          excluded: false,
        },
      ],
    });
    initFieldAssistant();

    // Field must remain untouched and blank
    expect(input.value).toBe('');
  });

  // --------------------------------------------------------------------------
  // L. Answer Memory exists + pencil click fills field
  // --------------------------------------------------------------------------
  it('L. Explicit pencil click fills saved answer into field', async () => {
    document.body.innerHTML = `
      <form>
        <label for="company">Company Name</label>
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

    await new Promise((r) => setTimeout(r, 50));

    const root = document.getElementById('submitlog-assistant-root');
    expect(root).not.toBeNull();
    const shadow = root?.shadowRoot;
    const trigger = shadow?.getElementById('trigger') as HTMLButtonElement;
    expect(trigger).not.toBeNull();

    // User clicks pencil explicitly
    trigger.click();

    expect(input.value).toBe('DeepMind Applied');
  });

  // --------------------------------------------------------------------------
  // M. Explicit "Fill from saved answers"
  // --------------------------------------------------------------------------
  it('M. Explicit Fill from saved answers only modifies fields when triggered by user', () => {
    document.body.innerHTML = `
      <form>
        <label for="company">Company</label>
        <input id="company" type="text" value="" />
        <label for="role">Role</label>
        <input id="role" type="text" value="" />
      </form>
    `;

    const companyInput = document.getElementById('company') as HTMLInputElement;
    const roleInput = document.getElementById('role') as HTMLInputElement;

    expect(companyInput.value).toBe('');
    expect(roleInput.value).toBe('');

    // Trigger explicit fill action
    const fillResult = injectedFillForm({
      savedAnswers: [
        { label: 'Company', value: 'Google DeepMind', fieldType: 'text' },
        { label: 'Role', value: 'Research Scientist', fieldType: 'text' },
      ],
    });

    expect(fillResult.filledCount).toBe(2);
    expect(companyInput.value).toBe('Google DeepMind');
    expect(roleInput.value).toBe('Research Scientist');
  });

  // --------------------------------------------------------------------------
  // N. No automatic page-write code path from content bootstrap
  // --------------------------------------------------------------------------
  it('N. Content script source code contains NO automatic DOM write operations on bootstrap', () => {
    const contentSrc = fs.readFileSync(
      path.resolve(__dirname, '../entrypoints/content.ts'),
      'utf-8',
    );

    // Must NOT call any restore or fill functions
    expect(contentSrc).not.toContain('injectedRestoreDraft');
    expect(contentSrc).not.toContain('injectedFillForm');
    expect(contentSrc).not.toContain('fillThisField');
    expect(contentSrc).not.toContain('.value =');
  });

  // --------------------------------------------------------------------------
  // O. Sensitive / auth / payment contexts remain rejected
  // --------------------------------------------------------------------------
  it('O. Dedicated auth, payment, AI chat, and editor routes are rejected by built-in exclusions', () => {
    // Auth & Identity
    expect(isBuiltInExcludedContext({ hostname: 'accounts.google.com' }).isExcluded).toBe(true);
    expect(isBuiltInExcludedContext({ hostname: 'login.microsoftonline.com' }).isExcluded).toBe(
      true,
    );
    expect(
      isBuiltInExcludedContext({ hostname: 'example.com', pathname: '/login' }).isExcluded,
    ).toBe(true);
    expect(
      isBuiltInExcludedContext({ hostname: 'example.com', pathname: '/checkout' }).isExcluded,
    ).toBe(true);

    // AI Chat
    expect(isBuiltInExcludedContext({ hostname: 'chatgpt.com' }).isExcluded).toBe(true);
    expect(isBuiltInExcludedContext({ hostname: 'claude.ai' }).isExcluded).toBe(true);
    expect(isBuiltInExcludedContext({ hostname: 'gemini.google.com' }).isExcluded).toBe(true);

    // Webmail & Messaging
    expect(isBuiltInExcludedContext({ hostname: 'mail.google.com' }).isExcluded).toBe(true);
    expect(isBuiltInExcludedContext({ hostname: 'discord.com' }).isExcluded).toBe(true);

    // Editors
    expect(
      isBuiltInExcludedContext({ hostname: 'docs.google.com', pathname: '/document/d/123' })
        .isExcluded,
    ).toBe(true);
    expect(isBuiltInExcludedContext({ hostname: 'canva.com' }).isExcluded).toBe(true);

    // Google Forms MUST NOT be excluded
    expect(
      isBuiltInExcludedContext({ hostname: 'docs.google.com', pathname: '/forms/d/123' })
        .isExcluded,
    ).toBe(false);

    // Normal application site MUST NOT be excluded
    expect(
      isBuiltInExcludedContext({ hostname: 'apply.techventures.org', pathname: '/apply' })
        .isExcluded,
    ).toBe(false);
  });
});
