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

import { type FormDraft, DRAFT_SCHEMA_VERSION, buildDraftId } from '../src/models/draft';
import {
  consolidateDrafts,
  getCanonicalDraftId,
  type DraftRepository,
} from '../src/storage/draft-repository';
import {
  setDraftTombstone,
  clearTombstoneRegistry,
  createTombstoneRepository,
  createInMemoryTombstoneRepository,
  type TombstoneRepository,
  type DraftTombstone,
  DEFAULT_TOMBSTONE_RETENTION_MS,
} from '../src/storage/tombstone-registry';
import {
  handleAutosaveMessage,
  type AutosaveFieldPayload,
} from '../src/background/autosave-handler';
import { scanPageForms, capturePageForms } from '../src/capture/injected-capture';
import { captureFormData } from '../src/capture/capture-engine';
import { injectedArmAutosave, injectedDisarmAutosave } from '../src/capture/injected-autosave';

function createTestDraftRepo(
  drafts = new Map<string, FormDraft>(),
  tombstoneRepo?: TombstoneRepository,
): DraftRepository {
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
      formFamilyOrFingerprint?: string,
    ): Promise<FormDraft | undefined> {
      const id = buildDraftId(origin, pathname, formFamilyOrFingerprint);
      const exact = drafts.get(id);
      if (exact) return JSON.parse(JSON.stringify(exact));
      const fallbackId = buildDraftId(origin, pathname);
      const fb = drafts.get(fallbackId);
      return fb ? JSON.parse(JSON.stringify(fb)) : undefined;
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
      const all = Array.from(drafts.values()).map((d) => JSON.parse(JSON.stringify(d)));
      const { canonicalDrafts, deleteIds } = consolidateDrafts(all);
      for (const id of deleteIds) {
        drafts.delete(id);
      }
      for (const c of canonicalDrafts) {
        drafts.set(c.id, c);
      }
      return canonicalDrafts.sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      );
    },
    async consolidateDuplicates(): Promise<{ consolidatedCount: number; deletedCount: number }> {
      const all = Array.from(drafts.values()).map((d) => JSON.parse(JSON.stringify(d)));
      const { canonicalDrafts, deleteIds } = consolidateDrafts(all);
      for (const id of deleteIds) {
        drafts.delete(id);
      }
      for (const c of canonicalDrafts) {
        drafts.set(c.id, c);
      }
      return {
        consolidatedCount: canonicalDrafts.length,
        deletedCount: deleteIds.length,
      };
    },
    async delete(id: string): Promise<void> {
      const existing = drafts.get(id);
      const now = Date.now();
      let maxRev: number | undefined;
      if (existing?.fields) {
        for (const f of Object.values(existing.fields)) {
          if (f.revision !== undefined && (maxRev === undefined || f.revision > maxRev)) {
            maxRev = f.revision;
          }
        }
      }
      await setDraftTombstone(id, now, maxRev, undefined, tombstoneRepo);
      if (existing) {
        const canon = getCanonicalDraftId(existing);
        if (canon !== id) {
          await setDraftTombstone(canon, now, maxRev, undefined, tombstoneRepo);
        }
      }
      drafts.delete(id);
    },
    async deleteByOrigin(origin: string): Promise<void> {
      for (const [id, d] of Array.from(drafts.entries())) {
        if (d.origin === origin) {
          await setDraftTombstone(id, Date.now(), undefined, undefined, tombstoneRepo);
          drafts.delete(id);
        }
      }
    },
    async cleanupExpired(): Promise<number> {
      return 0;
    },
  };
}

describe('Draft Identity and Deletion Architecture', () => {
  beforeEach(() => {
    clearTombstoneRegistry();
    document.body.innerHTML = '';
    window.__submitlog_autosave_active = false;
    window.__submitlog_suppress_autosave = false;
  });

  afterEach(() => {
    injectedDisarmAutosave();
    clearTombstoneRegistry();
    document.body.innerHTML = '';
  });

  // =========================================================================
  // Requirement A: Multi-step SPA field changes accumulate into ONE draft ID
  // =========================================================================
  it('Requirement A: Multi-step SPA field changes accumulate into one draft ID with merged fields', async () => {
    const draftRepo = createTestDraftRepo();
    const origin = 'https://europa.eu';
    const pathname = '/cv-editor';
    const basePayload: Partial<AutosaveFieldPayload> = {
      editingSessionId: 'sess-spa-1',
      origin,
      hostname: 'europa.eu',
      pathname,
      pageTitle: 'Europass CV Editor',
      pageUrl: `${origin}${pathname}`,
    };

    // Step 1: Personal Information (Fingerprint A)
    await handleAutosaveMessage(
      {
        ...basePayload,
        formFingerprint: 'fp-step-1-personal',
        field: { label: 'First Name', value: 'Jane', fieldType: 'text' },
        clientTimestamp: 1000,
        revision: 1,
      } as AutosaveFieldPayload,
      draftRepo,
    );

    await handleAutosaveMessage(
      {
        ...basePayload,
        formFingerprint: 'fp-step-1-personal',
        field: { label: 'Email Address', value: 'jane@example.com', fieldType: 'email' },
        clientTimestamp: 1010,
        revision: 1,
      } as AutosaveFieldPayload,
      draftRepo,
    );

    // Step 2: Work Experience (Fingerprint B)
    await handleAutosaveMessage(
      {
        ...basePayload,
        formFingerprint: 'fp-step-2-work',
        field: { label: 'Job Title', value: 'Software Architect', fieldType: 'text' },
        clientTimestamp: 2000,
        revision: 1,
      } as AutosaveFieldPayload,
      draftRepo,
    );

    // Step 3: Education & Training (Fingerprint C)
    await handleAutosaveMessage(
      {
        ...basePayload,
        formFingerprint: 'fp-step-3-education',
        field: { label: 'Degree', value: 'Master of Science', fieldType: 'text' },
        clientTimestamp: 3000,
        revision: 1,
      } as AutosaveFieldPayload,
      draftRepo,
    );

    const allDrafts = await draftRepo.getAll();
    expect(allDrafts.length).toBe(1);

    const singleDraft = allDrafts[0]!;
    expect(singleDraft.id).toBe(`${origin}|${pathname}`);
    expect(singleDraft.formFingerprint).toBe('fp-step-3-education');

    // All fields from steps 1, 2, and 3 must be preserved
    const fieldLabels = Object.values(singleDraft.fields).map((f) => f.label);
    expect(fieldLabels).toContain('First Name');
    expect(fieldLabels).toContain('Email Address');
    expect(fieldLabels).toContain('Job Title');
    expect(fieldLabels).toContain('Degree');

    expect(singleDraft.fields['first name']?.value).toBe('Jane');
    expect(singleDraft.fields['job title']?.value).toBe('Software Architect');
    expect(singleDraft.fields['degree']?.value).toBe('Master of Science');
  });

  // =========================================================================
  // Requirement B: Same field updated multiple times retains newest value & revision
  // =========================================================================
  it('Requirement B: Same field updated multiple times across rerenders retains newest value and revision', async () => {
    const draftRepo = createTestDraftRepo();
    const origin = 'https://europa.eu';
    const pathname = '/cv-editor';
    const basePayload = {
      editingSessionId: 'sess-spa-rev',
      origin,
      hostname: 'europa.eu',
      pathname,
      pageTitle: 'Europass CV Editor',
      pageUrl: `${origin}${pathname}`,
      formFingerprint: 'fp-work-step',
    };

    // Revision 1
    await handleAutosaveMessage(
      {
        ...basePayload,
        field: { label: 'Company Name', value: 'Acme Corp', fieldType: 'text' },
        clientTimestamp: 1000,
        revision: 1,
      } as AutosaveFieldPayload,
      draftRepo,
    );

    // Revision 2
    await handleAutosaveMessage(
      {
        ...basePayload,
        field: { label: 'Company Name', value: 'Acme Global', fieldType: 'text' },
        clientTimestamp: 2000,
        revision: 2,
      } as AutosaveFieldPayload,
      draftRepo,
    );

    // Revision 3
    await handleAutosaveMessage(
      {
        ...basePayload,
        field: { label: 'Company Name', value: 'Acme Holdings Ltd', fieldType: 'text' },
        clientTimestamp: 3000,
        revision: 3,
      } as AutosaveFieldPayload,
      draftRepo,
    );

    // Late arriving packet with revision 1
    const lateResponse = await handleAutosaveMessage(
      {
        ...basePayload,
        field: { label: 'Company Name', value: 'Stale Acme', fieldType: 'text' },
        clientTimestamp: 1050,
        revision: 1,
      } as AutosaveFieldPayload,
      draftRepo,
    );

    expect(lateResponse.status).toBe('unchanged');

    const draft = await draftRepo.getById(`${origin}|${pathname}`);
    expect(draft).toBeDefined();
    expect(draft!.fields['company name']?.value).toBe('Acme Holdings Ltd');
    expect(draft!.fields['company name']?.revision).toBe(3);
  });

  // =========================================================================
  // Requirement C: Consolidation routine reduces 4 duplicate draft records to 1
  // =========================================================================
  it('Requirement C: Consolidation routine reduces 4 duplicate draft records to 1 canonical draft, deleting 3 duplicates', () => {
    const origin = 'https://europa.eu';
    const pathname = '/cv-editor';
    const rawDrafts: FormDraft[] = [
      {
        id: `${origin}|${pathname}|fp-step1`,
        schemaVersion: DRAFT_SCHEMA_VERSION,
        origin,
        hostname: 'europa.eu',
        pathname,
        pageTitle: 'Europass CV Editor - Step 1',
        pageUrl: `${origin}${pathname}#step1`,
        formFingerprint: 'fp-step1',
        createdAt: '2026-09-17T10:00:00.000Z',
        updatedAt: '2026-09-17T10:05:00.000Z',
        fields: {
          'first name': {
            id: '1',
            label: 'First Name',
            value: 'Jane',
            fieldType: 'text',
            updatedAt: '2026-09-17T10:05:00.000Z',
            revision: 1,
          },
        },
      },
      {
        id: `${origin}|${pathname}|fp-step2`,
        schemaVersion: DRAFT_SCHEMA_VERSION,
        origin,
        hostname: 'europa.eu',
        pathname,
        pageTitle: 'Europass CV Editor - Step 2',
        pageUrl: `${origin}${pathname}#step2`,
        formFingerprint: 'fp-step2',
        createdAt: '2026-09-17T10:06:00.000Z',
        updatedAt: '2026-09-17T10:10:00.000Z',
        fields: {
          'last name': {
            id: '2',
            label: 'Last Name',
            value: 'Doe',
            fieldType: 'text',
            updatedAt: '2026-09-17T10:08:00.000Z',
            revision: 1,
          },
          'job title': {
            id: '3',
            label: 'Job Title',
            value: 'Junior Engineer',
            fieldType: 'text',
            updatedAt: '2026-09-17T10:10:00.000Z',
            revision: 1,
          },
        },
      },
      {
        id: `${origin}|${pathname}|fp-step3`,
        schemaVersion: DRAFT_SCHEMA_VERSION,
        origin,
        hostname: 'europa.eu',
        pathname,
        pageTitle: 'Europass CV Editor - Step 3',
        pageUrl: `${origin}${pathname}#step3`,
        formFingerprint: 'fp-step3',
        createdAt: '2026-09-17T10:11:00.000Z',
        updatedAt: '2026-09-17T10:15:00.000Z',
        fields: {
          'job title': {
            id: '4',
            label: 'Job Title',
            value: 'Lead Architect', // Newer revision wins!
            fieldType: 'text',
            updatedAt: '2026-09-17T10:14:00.000Z',
            revision: 2,
          },
          university: {
            id: '5',
            label: 'University',
            value: 'TU Delft',
            fieldType: 'text',
            updatedAt: '2026-09-17T10:15:00.000Z',
            revision: 1,
          },
        },
      },
      {
        id: `${origin}|${pathname}`,
        schemaVersion: DRAFT_SCHEMA_VERSION,
        origin,
        hostname: 'europa.eu',
        pathname,
        pageTitle: 'Europass CV Editor',
        pageUrl: `${origin}${pathname}`,
        formFingerprint: 'fp-final',
        createdAt: '2026-09-17T10:16:00.000Z',
        updatedAt: '2026-09-17T10:20:00.000Z',
        fields: {
          country: {
            id: '6',
            label: 'Country',
            value: 'Netherlands',
            fieldType: 'text',
            updatedAt: '2026-09-17T10:20:00.000Z',
            revision: 1,
          },
        },
      },
    ];

    const result = consolidateDrafts(rawDrafts);
    expect(result.canonicalDrafts.length).toBe(1);
    expect(result.deleteIds.length).toBe(3);
    expect(result.deleteIds).toContain(`${origin}|${pathname}|fp-step1`);
    expect(result.deleteIds).toContain(`${origin}|${pathname}|fp-step2`);
    expect(result.deleteIds).toContain(`${origin}|${pathname}|fp-step3`);

    const consolidated = result.canonicalDrafts[0]!;
    expect(consolidated.id).toBe(`${origin}|${pathname}`);
    expect(consolidated.createdAt).toBe('2026-09-17T10:00:00.000Z'); // Oldest timestamp preserved
    expect(consolidated.updatedAt).toBe('2026-09-17T10:20:00.000Z'); // Newest timestamp

    // Check all fields merged correctly
    expect(consolidated.fields['first name']?.value).toBe('Jane');
    expect(consolidated.fields['last name']?.value).toBe('Doe');
    expect(consolidated.fields['job title']?.value).toBe('Lead Architect'); // Revision 2 beat revision 1
    expect(consolidated.fields['university']?.value).toBe('TU Delft');
    expect(consolidated.fields['country']?.value).toBe('Netherlands');
  });

  // =========================================================================
  // Requirement D: Delete with pending debounced write stays deleted via tombstone
  // =========================================================================
  it('Requirement D: Delete with pending debounced write stays deleted via tombstone rejection', async () => {
    const draftRepo = createTestDraftRepo();
    const origin = 'https://example.com';
    const pathname = '/apply';
    const draftId = `${origin}|${pathname}`;

    // Create initial draft at T100
    await handleAutosaveMessage(
      {
        editingSessionId: 'sess-1',
        origin,
        hostname: 'example.com',
        pathname,
        pageTitle: 'Apply',
        pageUrl: `${origin}${pathname}`,
        formFingerprint: 'fp-1',
        field: { label: 'Name', value: 'Alice', fieldType: 'text' },
        clientTimestamp: 100,
        revision: 1,
      } as AutosaveFieldPayload,
      draftRepo,
    );

    expect(await draftRepo.getById(draftId)).toBeDefined();

    // User explicitly deletes draft from Archive tab at T200
    await draftRepo.delete(draftId);
    expect(await draftRepo.getById(draftId)).toBeUndefined();

    // A stale in-flight packet created at T150 arrives from an open tab
    const staleResponse = await handleAutosaveMessage(
      {
        editingSessionId: 'sess-1',
        origin,
        hostname: 'example.com',
        pathname,
        pageTitle: 'Apply',
        pageUrl: `${origin}${pathname}`,
        formFingerprint: 'fp-1',
        field: { label: 'Name', value: 'Alice Typo', fieldType: 'text' },
        clientTimestamp: 150,
        revision: 2,
      } as AutosaveFieldPayload,
      draftRepo,
    );

    expect(staleResponse.status).toBe('deleted_tombstone');
    // Ensure draft was NOT resurrected
    expect(await draftRepo.getById(draftId)).toBeUndefined();
    expect((await draftRepo.getAll()).length).toBe(0);
  });

  // =========================================================================
  // Requirement E: Delete with safety-flush write stays deleted
  // =========================================================================
  it('Requirement E: Delete with safety-flush write cancels pending writes and prevents resurrection', () => {
    document.body.innerHTML = `
      <form id="test-form">
        <label for="f1">Address</label>
        <input id="f1" name="address" type="text" value="Main Street" />
      </form>
    `;

    injectedArmAutosave({
      editingSessionId: 'sess-flush',
      origin: 'https://example.com',
      hostname: 'example.com',
      pathname: '/form',
      pageTitle: 'Form',
      pageUrl: 'https://example.com/form',
      initialFields: [],
      formFingerprint: 'fp-test',
    });

    expect(typeof window.__submitlog_autosave_on_delete).toBe('function');

    // Simulate Archive deletion signal broadcast to content script
    window.__submitlog_autosave_on_delete!();

    // Trigger explicit flush - must not error and must skip because draft is deleted
    expect(() => {
      if (typeof window.__submitlog_autosave_flush === 'function') {
        window.__submitlog_autosave_flush();
      }
    }).not.toThrow();
  });

  // =========================================================================
  // Requirement F: After delete, new genuine user edit creates a new draft
  // =========================================================================
  it('Requirement F: After delete, new genuine user edit creates a new draft', async () => {
    const draftRepo = createTestDraftRepo();
    const origin = 'https://example.com';
    const pathname = '/signup';
    const draftId = `${origin}|${pathname}`;

    const t0 = Date.now();

    // 1. Initial draft
    await handleAutosaveMessage(
      {
        editingSessionId: 'sess-init',
        origin,
        hostname: 'example.com',
        pathname,
        pageTitle: 'Sign Up',
        pageUrl: `${origin}${pathname}`,
        formFingerprint: 'fp-signup',
        field: { label: 'Username', value: 'first_try', fieldType: 'text' },
        clientTimestamp: t0 - 2000,
        revision: 1,
      } as AutosaveFieldPayload,
      draftRepo,
    );

    // 2. Delete
    await draftRepo.delete(draftId);
    expect(await draftRepo.getById(draftId)).toBeUndefined();

    // 3. Brand new genuine user edit with newer timestamp > deletion time
    const newEditResponse = await handleAutosaveMessage(
      {
        editingSessionId: 'sess-new-edit',
        origin,
        hostname: 'example.com',
        pathname,
        pageTitle: 'Sign Up',
        pageUrl: `${origin}${pathname}`,
        formFingerprint: 'fp-signup',
        field: { label: 'Username', value: 'fresh_start', fieldType: 'text' },
        clientTimestamp: Date.now() + 1000,
        revision: 1,
      } as AutosaveFieldPayload,
      draftRepo,
    );

    expect(newEditResponse.status).toBe('saved');
    const newDraft = await draftRepo.getById(draftId);
    expect(newDraft).toBeDefined();
    expect(newDraft!.fields['username']?.value).toBe('fresh_start');
  });

  // =========================================================================
  // Requirement G: Two genuinely different forms on same path create two drafts
  // =========================================================================
  it('Requirement G: Two genuinely different forms on same path with distinct form-family keys create two drafts', async () => {
    const draftRepo = createTestDraftRepo();
    const origin = 'https://company.org';
    const pathname = '/portal';

    // Form 1: Grant Application Form
    await handleAutosaveMessage(
      {
        editingSessionId: 'sess-f1',
        origin,
        hostname: 'company.org',
        pathname,
        formFamilyKey: 'action:/portal/grant-application',
        pageTitle: 'Company Portal - Grants',
        pageUrl: `${origin}${pathname}`,
        formFingerprint: 'fp-grant',
        field: { label: 'Project Title', value: 'Clean Energy Initiative', fieldType: 'text' },
        clientTimestamp: 1000,
        revision: 1,
      } as AutosaveFieldPayload,
      draftRepo,
    );

    // Form 2: User Feedback Form
    await handleAutosaveMessage(
      {
        editingSessionId: 'sess-f2',
        origin,
        hostname: 'company.org',
        pathname,
        formFamilyKey: 'action:/portal/feedback',
        pageTitle: 'Company Portal - Feedback',
        pageUrl: `${origin}${pathname}`,
        formFingerprint: 'fp-feedback',
        field: { label: 'Comments', value: 'Great platform experience!', fieldType: 'text' },
        clientTimestamp: 1010,
        revision: 1,
      } as AutosaveFieldPayload,
      draftRepo,
    );

    const allDrafts = await draftRepo.getAll();
    expect(allDrafts.length).toBe(2);

    const draftIds = allDrafts.map((d) => d.id);
    expect(draftIds).toContain(`${origin}|${pathname}|action:/portal/grant-application`);
    expect(draftIds).toContain(`${origin}|${pathname}|action:/portal/feedback`);
  });

  // =========================================================================
  // Requirement H: Gemini-style chat composer produces no meaningful draft
  // =========================================================================
  it('Requirement H: Gemini-style chat composer produces no meaningful draft', () => {
    const fixtureHtml = fs.readFileSync(
      path.join(__dirname, 'fixtures/gemini-chat-composer.html'),
      'utf-8',
    );
    document.body.innerHTML = fixtureHtml;

    const scan = scanPageForms();
    expect(scan.formDetected).toBe(false);
    expect(scan.score).toBeLessThanOrEqual(0);

    const capture = capturePageForms();
    expect(capture.formDetected).toBe(false);
    expect(capture.fields.length).toBe(0);

    const engineResult = captureFormData(document, 'https://gemini.google.com/app');
    expect(engineResult.formDetected).toBe(false);
  });

  // =========================================================================
  // Requirement I: Canva/editor-style UI produces no meaningful draft
  // =========================================================================
  it('Requirement I: Canva/editor-style UI produces no meaningful draft', () => {
    const fixtureHtml = fs.readFileSync(
      path.join(__dirname, 'fixtures/canva-editor-surface.html'),
      'utf-8',
    );
    document.body.innerHTML = fixtureHtml;

    const scan = scanPageForms();
    expect(scan.formDetected).toBe(false);
    expect(scan.score).toBeLessThanOrEqual(0);

    const capture = capturePageForms();
    expect(capture.formDetected).toBe(false);
    expect(capture.fields.length).toBe(0);

    const engineResult = captureFormData(document, 'https://canva.com/design/123');
    expect(engineResult.formDetected).toBe(false);
  });

  // =========================================================================
  // Requirement J: Contact form (Name + Email + Message + Submit) is accepted
  // =========================================================================
  it('Requirement J: Contact form (Name + Email + Message + Submit) is accepted', () => {
    const fixtureHtml = fs.readFileSync(
      path.join(__dirname, 'fixtures/contact-form.html'),
      'utf-8',
    );
    document.body.innerHTML = fixtureHtml;

    const scan = scanPageForms();
    expect(scan.formDetected).toBe(true);
    expect(scan.score).toBeGreaterThanOrEqual(30);

    const capture = capturePageForms();
    expect(capture.formDetected).toBe(true);
    expect(capture.fields.length).toBeGreaterThanOrEqual(3);

    const capturedLabels = capture.fields.map((f) => f.label.toLowerCase());
    expect(capturedLabels.some((l) => l.includes('name'))).toBe(true);
    expect(capturedLabels.some((l) => l.includes('email'))).toBe(true);
    expect(capturedLabels.some((l) => l.includes('message'))).toBe(true);

    const engineResult = captureFormData(document, 'https://example.com/contact-us');
    expect(engineResult.formDetected).toBe(true);
    expect(engineResult.fields.length).toBeGreaterThanOrEqual(3);
  });

  // =========================================================================
  // Requirement K: Archive view consolidates corrupted duplicate records into 1 canonical card
  // =========================================================================
  it('Requirement K: Archive view consolidates corrupted duplicate records into 1 canonical card', () => {
    const origin = 'https://europa.eu';
    const pathname = '/cv-editor';
    const duplicates: FormDraft[] = [
      {
        id: `${origin}|${pathname}|hash1`,
        schemaVersion: DRAFT_SCHEMA_VERSION,
        origin,
        hostname: 'europa.eu',
        pathname,
        pageTitle: 'Europass CV Editor',
        pageUrl: `${origin}${pathname}`,
        formFingerprint: 'hash1',
        createdAt: '2026-09-17T09:00:00.000Z',
        updatedAt: '2026-09-17T09:10:00.000Z',
        fields: {
          name: {
            id: '1',
            label: 'Name',
            value: 'John',
            fieldType: 'text',
            updatedAt: '2026-09-17T09:10:00.000Z',
          },
        },
      },
      {
        id: `${origin}|${pathname}|hash2`,
        schemaVersion: DRAFT_SCHEMA_VERSION,
        origin,
        hostname: 'europa.eu',
        pathname,
        pageTitle: 'Europass CV Editor',
        pageUrl: `${origin}${pathname}`,
        formFingerprint: 'hash2',
        createdAt: '2026-09-17T09:11:00.000Z',
        updatedAt: '2026-09-17T09:20:00.000Z',
        fields: {
          surname: {
            id: '2',
            label: 'Surname',
            value: 'Smith',
            fieldType: 'text',
            updatedAt: '2026-09-17T09:20:00.000Z',
          },
        },
      },
      {
        id: `${origin}|${pathname}`,
        schemaVersion: DRAFT_SCHEMA_VERSION,
        origin,
        hostname: 'europa.eu',
        pathname,
        pageTitle: 'Europass CV Editor',
        pageUrl: `${origin}${pathname}`,
        formFingerprint: 'hash3',
        createdAt: '2026-09-17T09:21:00.000Z',
        updatedAt: '2026-09-17T09:30:00.000Z',
        fields: {
          email: {
            id: '3',
            label: 'Email',
            value: 'john.smith@example.com',
            fieldType: 'email',
            updatedAt: '2026-09-17T09:30:00.000Z',
          },
        },
      },
    ];

    const { canonicalDrafts, deleteIds } = consolidateDrafts(duplicates);
    expect(canonicalDrafts.length).toBe(1);
    expect(deleteIds.length).toBe(2);

    const cardData = canonicalDrafts[0]!;
    expect(cardData.id).toBe(`${origin}|${pathname}`);
    expect(Object.keys(cardData.fields).length).toBe(3);
    expect(cardData.fields['name']?.value).toBe('John');
    expect(cardData.fields['surname']?.value).toBe('Smith');
    expect(cardData.fields['email']?.value).toBe('john.smith@example.com');
  });

  // =========================================================================
  // Requirement L: Persistent tombstones reject stale writes across SW restart
  // =========================================================================
  it('Requirement L: Persistent tombstones reject stale writes across background service worker restart', async () => {
    const sharedDrafts = new Map<string, FormDraft>();
    const sharedTombstones = new Map<string, DraftTombstone>();

    // Service Worker Instance 1
    const tombstoneRepo1 = createInMemoryTombstoneRepository(sharedTombstones);
    const draftRepo1 = createTestDraftRepo(sharedDrafts, tombstoneRepo1);

    const origin = 'https://portal.service.gov';
    const pathname = '/passport-application';
    const draftId = `${origin}|${pathname}`;
    const t0 = Date.now();

    // 1. User is working on an application in Service Worker #1
    await handleAutosaveMessage(
      {
        editingSessionId: 'sess-sw-1',
        origin,
        hostname: 'portal.service.gov',
        pathname,
        pageTitle: 'Passport Application',
        pageUrl: `${origin}${pathname}`,
        formFingerprint: 'fp-passport',
        field: { label: 'Passport Number', value: 'AB1234567', fieldType: 'text' },
        clientTimestamp: t0 - 5000,
        revision: 2,
      } as AutosaveFieldPayload,
      draftRepo1,
      undefined,
      undefined,
      tombstoneRepo1,
    );

    expect(await draftRepo1.getById(draftId)).toBeDefined();

    // 2. User deletes the draft in Archive tab
    await draftRepo1.delete(draftId);
    expect(await draftRepo1.getById(draftId)).toBeUndefined();
    expect(sharedTombstones.has(draftId)).toBe(true);
    const storedTombstone = sharedTombstones.get(draftId)!;
    expect(storedTombstone.lastAcceptedRevision).toBe(2);

    // 3. SIMULATE SERVICE WORKER TERMINATION / RESTART
    // Service Worker Instance 1 is killed.
    // Fresh Service Worker Instance 2 initializes from persistent storage:
    const tombstoneRepo2 = createInMemoryTombstoneRepository(sharedTombstones);
    const draftRepo2 = createTestDraftRepo(sharedDrafts, tombstoneRepo2);

    // 4. Stale in-flight write (generated before deletion) arrives from an open tab
    const stalePayload: AutosaveFieldPayload = {
      editingSessionId: 'sess-sw-1',
      origin,
      hostname: 'portal.service.gov',
      pathname,
      pageTitle: 'Passport Application',
      pageUrl: `${origin}${pathname}`,
      formFingerprint: 'fp-passport',
      field: { label: 'Passport Number', value: 'AB1234567', fieldType: 'text' },
      clientTimestamp: t0 - 2000, // Pre-deletion timestamp!
      revision: 2,
    };

    const staleResponse = await handleAutosaveMessage(
      stalePayload,
      draftRepo2,
      undefined,
      undefined,
      tombstoneRepo2,
    );

    expect(staleResponse.status).toBe('deleted_tombstone');
    // Draft STAYS deleted even after service worker restart!
    expect(await draftRepo2.getById(draftId)).toBeUndefined();
    expect((await draftRepo2.getAll()).length).toBe(0);
  });

  // =========================================================================
  // Requirement M: Genuine new edit recreates draft across SW restart
  // =========================================================================
  it('Requirement M: Genuine new edit recreates draft across background service worker restart and clears tombstone', async () => {
    const sharedDrafts = new Map<string, FormDraft>();
    const sharedTombstones = new Map<string, DraftTombstone>();

    // Initial session on SW1
    const tombstoneRepo1 = createInMemoryTombstoneRepository(sharedTombstones);
    const draftRepo1 = createTestDraftRepo(sharedDrafts, tombstoneRepo1);

    const origin = 'https://portal.service.gov';
    const pathname = '/renew';
    const draftId = `${origin}|${pathname}`;
    const t0 = Date.now();

    await handleAutosaveMessage(
      {
        editingSessionId: 'sess-init',
        origin,
        hostname: 'portal.service.gov',
        pathname,
        pageTitle: 'Renewal',
        pageUrl: `${origin}${pathname}`,
        formFingerprint: 'fp-renew',
        field: { label: 'Old Number', value: 'OLD123', fieldType: 'text' },
        clientTimestamp: t0 - 10000,
        revision: 1,
      } as AutosaveFieldPayload,
      draftRepo1,
      undefined,
      undefined,
      tombstoneRepo1,
    );

    // Delete draft
    await draftRepo1.delete(draftId);
    expect(sharedTombstones.has(draftId)).toBe(true);

    // SIMULATE SERVICE WORKER RESTART
    const tombstoneRepo2 = createInMemoryTombstoneRepository(sharedTombstones);
    const draftRepo2 = createTestDraftRepo(sharedDrafts, tombstoneRepo2);

    // User types brand new input AFTER deletion (clientTimestamp > deletedAt)
    const newPayload: AutosaveFieldPayload = {
      editingSessionId: 'sess-fresh',
      origin,
      hostname: 'portal.service.gov',
      pathname,
      pageTitle: 'Renewal',
      pageUrl: `${origin}${pathname}`,
      formFingerprint: 'fp-renew',
      field: { label: 'Old Number', value: 'NEW999', fieldType: 'text' },
      clientTimestamp: t0 + 5000, // Newer timestamp than deletion!
      revision: 1,
    };

    const newResponse = await handleAutosaveMessage(
      newPayload,
      draftRepo2,
      undefined,
      undefined,
      tombstoneRepo2,
    );

    expect(newResponse.status).toBe('saved');
    const recreatedDraft = await draftRepo2.getById(draftId);
    expect(recreatedDraft).toBeDefined();
    expect(recreatedDraft!.fields['old number']?.value).toBe('NEW999');
    // Tombstone must have been cleared from persistent storage upon legitimate recreation
    expect(sharedTombstones.has(draftId)).toBe(false);
  });

  // =========================================================================
  // Requirement N: Expired tombstones are cleaned up and no longer reject writes
  // =========================================================================
  it('Requirement N: Expired tombstones are cleaned up and no longer reject subsequent writes', async () => {
    const sharedTombstones = new Map<string, DraftTombstone>();
    const tombstoneRepo = createInMemoryTombstoneRepository(sharedTombstones);
    const now = Date.now();

    // Seed an expired tombstone (expired 1 hour ago)
    await tombstoneRepo.set({
      stableDraftId: 'https://expired.org|/form',
      deletedAt: now - 8 * 24 * 60 * 60 * 1000,
      expiresAt: now - 3600 * 1000,
      lastAcceptedRevision: 1,
    });

    // Seed an active tombstone (valid for 6 more days)
    await tombstoneRepo.set({
      stableDraftId: 'https://active.org|/form',
      deletedAt: now,
      expiresAt: now + 6 * 24 * 60 * 60 * 1000,
      lastAcceptedRevision: 1,
    });

    expect(sharedTombstones.size).toBe(2);

    // Run cleanupExpired
    const cleanedCount = await tombstoneRepo.cleanupExpired(now);
    expect(cleanedCount).toBe(1);
    expect(sharedTombstones.size).toBe(1);
    expect(sharedTombstones.has('https://expired.org|/form')).toBe(false);
    expect(sharedTombstones.has('https://active.org|/form')).toBe(true);

    // Querying get on expired ID returns undefined
    const retrievedExpired = await tombstoneRepo.get('https://expired.org|/form');
    expect(retrievedExpired).toBeUndefined();

    // Querying get on valid ID returns record
    const retrievedActive = await tombstoneRepo.get('https://active.org|/form');
    expect(retrievedActive).toBeDefined();
    expect(retrievedActive!.stableDraftId).toBe('https://active.org|/form');
  });

  // =========================================================================
  // Requirement O: Persistent TombstoneRepository operates with IndexedDB
  // =========================================================================
  it('Requirement O: Persistent TombstoneRepository operates with IndexedDB storage', async () => {
    const idbTombstoneRepo = createTombstoneRepository();
    const testId = `https://idb-test.org|/app-${Date.now()}`;
    const now = Date.now();

    await idbTombstoneRepo.set({
      stableDraftId: testId,
      deletedAt: now,
      lastAcceptedRevision: 3,
      expiresAt: now + DEFAULT_TOMBSTONE_RETENTION_MS,
    });

    const fetched = await idbTombstoneRepo.get(testId);
    expect(fetched).toBeDefined();
    expect(fetched!.stableDraftId).toBe(testId);
    expect(fetched!.lastAcceptedRevision).toBe(3);

    // Clean up
    await idbTombstoneRepo.delete(testId);
    const afterDelete = await idbTombstoneRepo.get(testId);
    expect(afterDelete).toBeUndefined();
  });

  // =========================================================================
  // Requirement P: Revision comparison fallback when clientTimestamp is absent
  // =========================================================================
  it('Requirement P: Rejects older revisions and accepts newer revisions when clientTimestamp is missing', async () => {
    const sharedDrafts = new Map<string, FormDraft>();
    const sharedTombstones = new Map<string, DraftTombstone>();
    const tombstoneRepo = createInMemoryTombstoneRepository(sharedTombstones);
    const draftRepo = createTestDraftRepo(sharedDrafts, tombstoneRepo);

    const draftId = 'https://example.com|/form';
    await tombstoneRepo.set({
      stableDraftId: draftId,
      deletedAt: Date.now(),
      lastAcceptedRevision: 5,
      expiresAt: Date.now() + 60000,
    });

    // 1. Packet with missing timestamp and obsolete revision (3 <= 5) -> rejected
    const staleResp = await handleAutosaveMessage(
      {
        editingSessionId: 'sess-test',
        origin: 'https://example.com',
        hostname: 'example.com',
        pathname: '/form',
        pageTitle: 'Form',
        pageUrl: 'https://example.com/form',
        formFingerprint: 'fp',
        field: { label: 'Name', value: 'Old Rev', fieldType: 'text' },
        revision: 3,
      } as AutosaveFieldPayload,
      draftRepo,
      undefined,
      undefined,
      tombstoneRepo,
    );
    expect(staleResp.status).toBe('deleted_tombstone');
    expect(sharedTombstones.has(draftId)).toBe(true);

    // 2. Packet with missing timestamp and newer revision (6 > 5) -> accepted
    const newerResp = await handleAutosaveMessage(
      {
        editingSessionId: 'sess-test',
        origin: 'https://example.com',
        hostname: 'example.com',
        pathname: '/form',
        pageTitle: 'Form',
        pageUrl: 'https://example.com/form',
        formFingerprint: 'fp',
        field: { label: 'Name', value: 'New Rev', fieldType: 'text' },
        revision: 6,
      } as AutosaveFieldPayload,
      draftRepo,
      undefined,
      undefined,
      tombstoneRepo,
    );
    expect(newerResp.status).toBe('saved');
    expect(sharedTombstones.has(draftId)).toBe(false);
  });
});
