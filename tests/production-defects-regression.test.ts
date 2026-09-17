import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isFieldSensitive, handleAutosaveMessage } from '../src/background/autosave-handler';
import { isSensitiveText, isElementSensitive } from '../src/security/sensitive-patterns';
import { checkSensitiveField } from '../src/capture/sensitive-filter';
import { injectedArmAutosave, injectedDisarmAutosave } from '../src/capture/injected-autosave';
import { scanPageForms, capturePageForms } from '../src/capture/injected-capture';
import { injectedFillForm } from '../src/capture/injected-fill';
import { normalizeDraftPathname, buildDraftId, type FormDraft } from '../src/models/draft';
import { AnswerIndex } from '../src/assistant/answer-index';
import { calculateLabelSimilarity, findFieldMatch } from '../src/matching/field-matcher';
import type { DraftRepository } from '../src/storage/draft-repository';

describe('Production Security and Correctness Defect Regressions', () => {
  // =========================================================================
  // 1. FINANCIAL & IDENTITY PII CAPTURE PROTECTION (P0)
  // =========================================================================
  describe('1. Financial & Identity PII Capture Protection', () => {
    const piiFields = [
      'Bank Account Number',
      'Routing Number',
      'IBAN',
      'SWIFT code',
      'SWIFT/BIC',
      'BIC',
      'Tax ID',
      'Taxpayer Identification Number',
      'TIN',
      'National ID',
      'National Identity Number',
      'EIN',
      'Date of Birth',
      'DOB',
      'dob1',
      'ein123',
      'Passport Number',
      "Driver's License Number",
      'Social Security Number',
      'card_number',
      'one_time_code',
    ];

    it.each(piiFields)('flags "%s" as sensitive in isSensitiveText', (label) => {
      expect(isSensitiveText(label)).toBe(true);
    });

    it.each(piiFields)('flags "%s" as sensitive in isFieldSensitive (background)', (label) => {
      expect(isFieldSensitive(label, 'text')).toBe(true);
    });

    it.each(piiFields)(
      'flags input with label "%s" as sensitive in isElementSensitive',
      (label) => {
        const input = document.createElement('input');
        input.type = 'text';
        expect(isElementSensitive(input, label).isSensitive).toBe(true);
      },
    );

    it.each(piiFields)('refuses to autosave "%s" to background persistence', async (fieldLabel) => {
      const drafts = new Map<string, FormDraft>();
      const mockDraftRepo: DraftRepository = {
        save: async (d) => {
          drafts.set(d.id, d);
        },
        getById: async (id) => drafts.get(id),
        getByForm: async () => undefined,
        getByOrigin: async () => [],
        getAll: async () => Array.from(drafts.values()),
        delete: async (id) => {
          drafts.delete(id);
        },
        deleteByOrigin: async () => {},
        cleanupExpired: async () => 0,
      };

      const res = await handleAutosaveMessage(
        {
          hostname: 'bank.example.com',
          origin: 'https://bank.example.com',
          pathname: '/form',
          pageTitle: 'Banking Intake',
          pageUrl: 'https://bank.example.com/form',
          field: {
            label: fieldLabel,
            value: 'LEAKED_SECRET_VALUE_12345',
            fieldType: 'text',
          },
        },
        mockDraftRepo,
      );

      expect(res.status).toBe('skipped');
      expect(drafts.size).toBe(0);
    });

    const nonPiiFields = [
      'Swift',
      'Swift Experience',
      'Primary Language: Swift',
      'Routing preference',
      'Packet routing',
      'Call routing',
      'Bank name',
      'Banking experience',
      'GitHub account',
      'Account manager',
      'Account name',
      'User account',
      'Birth place',
      'Place of birth',
      'Driver',
      'Driving experience',
      'License type',
      'Professional license',
      'Tax experience',
    ];

    it.each(nonPiiFields)('does NOT flag "%s" as sensitive (false positive guard)', (label) => {
      expect(isSensitiveText(label)).toBe(false);
      expect(isFieldSensitive(label, 'text')).toBe(false);
      const input = document.createElement('input');
      input.type = 'text';
      expect(isElementSensitive(input, label).isSensitive).toBe(false);
    });

    it('excludes PII fields from capturePageForms or marks them excluded', () => {
      document.body.innerHTML = `
        <form id="loan-app">
          <label for="f_bank">Bank Account Number</label>
          <input id="f_bank" type="text" value="123456789" />

          <label for="f_routing">Routing Number</label>
          <input id="f_routing" type="text" value="987654321" />

          <label for="f_dob">Date of Birth</label>
          <input id="f_dob" type="text" value="1990-01-01" />

          <label for="f_safe">Favorite Color</label>
          <input id="f_safe" type="text" value="Emerald Green" />
        </form>
      `;

      const result = capturePageForms();
      expect(result.formDetected).toBe(true);

      // The 3 sensitive fields must be excluded and have empty value
      const bankField = result.fields.find((f) => f.label.includes('Bank Account'));
      expect(bankField?.excluded).toBe(true);
      expect(bankField?.value).toBe('');

      const routingField = result.fields.find((f) => f.label.includes('Routing'));
      expect(routingField?.excluded).toBe(true);
      expect(routingField?.value).toBe('');

      const dobField = result.fields.find((f) => f.label.includes('Date of Birth'));
      expect(dobField?.excluded).toBe(true);
      expect(dobField?.value).toBe('');

      // Safe field is included
      const safeField = result.fields.find((f) => f.label.includes('Favorite Color'));
      expect(safeField?.excluded).toBe(false);
      expect(safeField?.value).toBe('Emerald Green');
    });

    it('injectedFillForm refuses to fill PII fields and marks them skipped_sensitive', () => {
      document.body.innerHTML = `
        <form>
          <label for="ssn">Social Security Number</label>
          <input id="ssn" type="text" />

          <label for="iban">IBAN</label>
          <input id="iban" type="text" />

          <label for="name">Your Name</label>
          <input id="name" type="text" />
        </form>
      `;

      const fillResult = injectedFillForm({
        savedAnswers: [
          { label: 'Social Security Number', value: '123-45-6789', fieldType: 'text' },
          { label: 'IBAN', value: 'DE89370400440532013000', fieldType: 'text' },
          { label: 'Your Name', value: 'Grace Hopper', fieldType: 'text' },
        ],
      });

      expect(fillResult.sensitiveSkippedCount).toBe(2);
      expect(fillResult.filledCount).toBe(1);

      const ssnInput = document.getElementById('ssn') as HTMLInputElement;
      const ibanInput = document.getElementById('iban') as HTMLInputElement;
      const nameInput = document.getElementById('name') as HTMLInputElement;

      expect(ssnInput.value).toBe('');
      expect(ibanInput.value).toBe('');
      expect(nameInput.value).toBe('Grace Hopper');
    });
  });

  // =========================================================================
  // 2. FILTER PARITY ACROSS ALL RUNTIME LOCATIONS
  // =========================================================================
  describe('2. Filter Parity Across All 6 Filter Locations', () => {
    const testCases = [
      { name: 'pwd', label: 'Password', sensitive: true },
      { name: 'routing_num', label: 'Bank Routing', sensitive: true },
      { name: 'iban_code', label: 'International IBAN', sensitive: true },
      { name: 'swift_bic', label: 'SWIFT Code', sensitive: true },
      { name: 'dob_input', label: 'Date of Birth', sensitive: true },
      { name: 'driver_lic', label: "Driver's License", sensitive: true },
      { name: 'first_name', label: 'First Name', sensitive: false },
      { name: 'email_addr', label: 'Email Address', sensitive: false },
      { name: 'project_bio', label: 'Project Description', sensitive: false },
    ];

    it.each(testCases)(
      'checks parity for "$label": sensitive = $sensitive',
      ({ name, label, sensitive }) => {
        // 1. Canonical sensitive-patterns
        expect(isSensitiveText(label)).toBe(sensitive);
        expect(isSensitiveText(name)).toBe(sensitive);

        // 2. Background isFieldSensitive
        expect(isFieldSensitive(label, 'text')).toBe(sensitive);

        // 3. sensitive-filter checkSensitiveField
        const el = document.createElement('input');
        el.name = name;
        el.setAttribute('aria-label', label);
        expect(checkSensitiveField(el).isSensitive).toBe(sensitive);
      },
    );
  });

  // =========================================================================
  // 3. FOCUSOUT-AFTER-DELETE RESURRECTION (P1)
  // =========================================================================
  describe('3. Focusout-After-Delete Resurrection Prevention', () => {
    interface MockAutosaveMessage {
      type: string;
      payload: {
        field: {
          label: string;
          value: string;
          fieldType: string;
        };
      };
    }

    let dispatchedMessages: MockAutosaveMessage[] = [];

    beforeEach(() => {
      dispatchedMessages = [];
      const mockRuntime = {
        sendMessage: vi.fn((msg: unknown, cb?: (res: unknown) => void) => {
          dispatchedMessages.push(msg as MockAutosaveMessage);
          if (cb) cb({ submissionId: 'sub-123' });
          return Promise.resolve({ submissionId: 'sub-123' });
        }),
      };
      const g = globalThis as unknown as Record<string, unknown>;
      g.browser = { runtime: mockRuntime };
      g.chrome = { runtime: mockRuntime };
    });

    afterEach(() => {
      injectedDisarmAutosave(false);
      const g = globalThis as unknown as Record<string, unknown>;
      delete g.browser;
      delete g.chrome;
    });

    it('focusout after delete does NOT dispatch an autosave write and draft remains deleted', () => {
      document.body.innerHTML = `
        <form>
          <label for="applicantName">Applicant Name</label>
          <input id="applicantName" type="text" value="Margaret Hamilton" />
        </form>
      `;

      injectedArmAutosave({
        editingSessionId: 'sess-delete-test',
        hostname: 'apply.nasa.gov',
        pageTitle: 'Apollo Application',
        pageUrl: 'https://apply.nasa.gov/apply',
        initialFields: [{ label: 'Applicant Name', fieldType: 'text' }],
      });

      const input = document.getElementById('applicantName') as HTMLInputElement;

      // 1. User is focused on the input
      input.focus();

      // 2. User deletes the draft in Popup / Archive
      window.__submitlog_autosave_on_delete?.();
      dispatchedMessages = [];

      // 3. User clicks away / window blurs / focusout occurs without editing
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));

      // MUST NOT send any autosave message!
      expect(dispatchedMessages).toHaveLength(0);
    });

    it('a genuine new edit after delete DOES recreate the draft with newer timestamp', () => {
      document.body.innerHTML = `
        <form>
          <label for="applicantName">Applicant Name</label>
          <input id="applicantName" type="text" value="Margaret" />
        </form>
      `;

      injectedArmAutosave({
        editingSessionId: 'sess-recreate-test',
        hostname: 'apply.nasa.gov',
        pageTitle: 'Apollo Application',
        pageUrl: 'https://apply.nasa.gov/apply',
        initialFields: [{ label: 'Applicant Name', fieldType: 'text' }],
      });

      const input = document.getElementById('applicantName') as HTMLInputElement;

      // 1. User deletes the draft
      window.__submitlog_autosave_on_delete?.();
      dispatchedMessages = [];

      // 2. User types a genuine new edit (input event)
      input.value = 'Margaret Hamilton (Updated)';
      input.dispatchEvent(new Event('input', { bubbles: true }));

      // 3. User blurs or flushes
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));

      // MUST dispatch the new edit!
      expect(dispatchedMessages).toHaveLength(1);
      const msg = dispatchedMessages[0];
      expect(msg).toBeDefined();
      expect(msg?.type).toBe('SUBMITLOG_AUTOSAVE_FIELD');
      expect(msg?.payload.field.value).toBe('Margaret Hamilton (Updated)');
    });
  });

  // =========================================================================
  // 4. HASH-SPA ISOLATION & TRAILING SLASH NORMALIZATION (P2)
  // =========================================================================
  describe('4. Hash-SPA Isolation and Trailing Slash Normalization', () => {
    it('isolates hash-routed SPA paths into distinct draft identities', () => {
      const contactUrl = 'https://spa.example.com/#/contact';
      const jobsUrl = 'https://spa.example.com/#/jobs/55/apply';

      const normContact = normalizeDraftPathname(contactUrl);
      const normJobs = normalizeDraftPathname(jobsUrl);

      expect(normContact).toBe('/contact');
      expect(normJobs).toBe('/jobs/55/apply');
      expect(normContact).not.toBe(normJobs);

      const idContact = buildDraftId('https://spa.example.com', normContact);
      const idJobs = buildDraftId('https://spa.example.com', normJobs);

      expect(idContact).toBe('https://spa.example.com|/contact');
      expect(idJobs).toBe('https://spa.example.com|/jobs/55/apply');
      expect(idContact).not.toBe(idJobs);
    });

    it('normalizes trailing slashes to prevent draft fragmentation', () => {
      const path1 = normalizeDraftPathname('https://example.com/apply');
      const path2 = normalizeDraftPathname('https://example.com/apply/');
      const path3 = normalizeDraftPathname('https://example.com/apply///');

      expect(path1).toBe('/apply');
      expect(path2).toBe('/apply');
      expect(path3).toBe('/apply');

      const id1 = buildDraftId('https://example.com', path1);
      const id2 = buildDraftId('https://example.com', path2);

      expect(id1).toBe(id2);
    });
  });

  // =========================================================================
  // 5. ANSWER MEMORY & FIELD MATCHER ADVERSARIAL COLLISIONS (P2)
  // =========================================================================
  describe('5. Answer Memory & Field Matcher Collision Protections', () => {
    const adversarialPairs = [
      ['Portfolio', 'Portfolio password'],
      ['Salary', 'Expected salary'],
      ['Salary', 'Current salary'],
      ['Employer', 'Previous employer'],
      ['Employer', 'Current employer'],
      ['Email', 'Confirm email'],
      ['Password', 'Confirm password'],
      ['Have you ever been terminated?', 'Have you ever been promoted?'],
      ['Why are you interested in this position?', 'Why are you interested in this company?'],
      ['Years of experience', 'Years of experience in management'],
      ['Name', 'Company Name'],
      ['Address', 'Email Address'],
    ];

    it.each(adversarialPairs)(
      'rejects false match between "%s" and "%s" in calculateLabelSimilarity',
      (target, candidate) => {
        const similarity = calculateLabelSimilarity(target, candidate);
        expect(similarity).toBeLessThan(0.75);
      },
    );

    it.each(adversarialPairs)(
      'rejects false match between "%s" and "%s" in findFieldMatch',
      (target, candidate) => {
        const result = findFieldMatch({ label: target, fieldType: 'text' }, [
          { label: candidate, fieldType: 'text' },
        ]);
        expect(result).toBeUndefined();
      },
    );

    it.each(adversarialPairs)(
      'rejects false match between "%s" and "%s" in AnswerIndex.getSuggestions',
      (target, candidate) => {
        const index = new AnswerIndex([
          {
            id: 'sub-test',
            schemaVersion: 2,
            createdAt: '2026-09-01T00:00:00Z',
            hostname: 'example.com',
            pageUrl: 'https://example.com/form',
            pageTitle: 'Test Form',
            submissionTitle: 'Test Form',
            captureVersion: '1.0.0',
            fields: [
              {
                id: 'f-cand',
                label: candidate,
                value: 'Secret / Distinct Answer',
                fieldType: 'text',
                labelSource: 'label-for',
                excluded: false,
              },
            ],
          },
        ]);

        const suggestions = index.getSuggestions(target);
        expect(suggestions).toHaveLength(0);
      },
    );

    const positivePairs: Array<[string, string]> = [
      ['GitHub', 'GitHub URL'],
      ['GitHub', 'GitHub profile URL'],
      ['LinkedIn', 'LinkedIn URL'],
      ['Portfolio', 'Portfolio URL'],
      ['Phone', 'Phone number'],
      ['Email', 'Email Address'],
      ['What is your phone number?', 'Phone number'],
      ['Your Current Address', 'Current address'],
      ['Company', 'Company Name'],
      ['Your full legal name', 'Full legal name'],
    ];

    it.each(positivePairs)(
      'matches legitimate semantic variants "%s" ↔ "%s" in field-matcher and AnswerIndex',
      (target, candidate) => {
        const sim = calculateLabelSimilarity(target, candidate);
        expect(sim).toBeGreaterThanOrEqual(0.75);

        const match = findFieldMatch({ label: target, fieldType: 'text' }, [
          { label: candidate, fieldType: 'text' },
        ]);
        expect(match).toBeDefined();
        expect(match?.label).toBe(candidate);

        const index = new AnswerIndex([
          {
            id: 'sub-pos-test',
            schemaVersion: 2,
            createdAt: '2026-09-01T00:00:00Z',
            hostname: 'example.com',
            pageUrl: 'https://example.com/form',
            pageTitle: 'Test Form',
            submissionTitle: 'Test Form',
            captureVersion: '1.0.0',
            fields: [
              {
                id: 'f-cand',
                label: candidate,
                value: 'Saved Useful Answer',
                fieldType: 'text',
                labelSource: 'label-for',
                excluded: false,
              },
            ],
          },
        ]);

        const suggestions = index.getSuggestions(target);
        expect(suggestions.length).toBeGreaterThan(0);
        expect(suggestions[0]?.value).toBe('Saved Useful Answer');
      },
    );
  });

  // =========================================================================
  // 6. FILE INPUT NON-CAPTURE GUARANTEE
  // =========================================================================
  describe('6. File Input Exclusion Guarantee', () => {
    it('scanPageForms and capturePageForms do not collect file inputs', () => {
      document.body.innerHTML = `
        <form action="/submit-app">
          <label for="resume">Upload Resume</label>
          <input id="resume" type="file" />

          <label for="name">Your Name</label>
          <input id="name" type="text" value="Ada" />

          <label for="email">Your Email</label>
          <input id="email" type="email" value="ada@example.org" />

          <button type="submit">Submit Application</button>
        </form>
      `;

      const scan = scanPageForms();
      expect(scan.formDetected).toBe(true);
      expect(scan.detectedFields?.some((f) => f.label.includes('Resume'))).toBe(false);

      const capture = capturePageForms();
      expect(capture.fields.some((f) => f.fieldType === 'file')).toBe(false);
      expect(capture.fields.some((f) => f.label.includes('Resume'))).toBe(false);
    });
  });

  // =========================================================================
  // 7. SENSITIVE PATTERN PARITY ACROSS SERIALIZED MODULES
  // =========================================================================
  describe('7. Sensitive Pattern Parity Across Serialized Copies', () => {
    it('verifies injected-capture.ts and injected-fill.ts contain identical regex patterns to canonical', async () => {
      const fs = await import('fs');
      const canonicalFile = fs.readFileSync('src/security/sensitive-patterns.ts', 'utf8');
      const captureFile = fs.readFileSync('src/capture/injected-capture.ts', 'utf8');
      const fillFile = fs.readFileSync('src/capture/injected-fill.ts', 'utf8');

      const canonicalRegex = canonicalFile.match(/SENSITIVE_PATTERNS\s*=\s*(\/[^\n]+\/i);/)?.[1];
      const captureRegexes = Array.from(
        captureFile.matchAll(/SENSITIVE_PATTERN\s*=\s*(\/[^\n]+\/i);/g),
      ).map((m) => m[1]);
      const fillRegex = fillFile.match(/SENSITIVE_PATTERN\s*=\s*(\/[^\n]+\/i);/)?.[1];

      expect(canonicalRegex).toBeDefined();
      expect(captureRegexes.length).toBe(2);
      expect(captureRegexes[0]).toBe(canonicalRegex);
      expect(captureRegexes[1]).toBe(canonicalRegex);
      expect(fillRegex).toBe(canonicalRegex);
    });
  });
});
