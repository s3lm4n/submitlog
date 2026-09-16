import { describe, it, expect, beforeEach } from 'vitest';
import { computeFormFingerprint } from '../src/matching/form-fingerprint';
import { matchForm, findFieldMatch } from '../src/matching/field-matcher';
import { mergeSubmissions } from '../src/matching/form-merger';
import { injectedFillForm } from '../src/capture/injected-fill';
import { migrateSubmission } from '../src/storage/submission-repository';
import type { Submission, CapturedField } from '../src/models/submission';
import { SCHEMA_VERSION } from '../src/models/submission';

describe('Form Identity, Matching, Filling, and Merging', () => {
  const baseSavedSubmission: Submission = {
    id: 'sub-grant-01',
    schemaVersion: 1,
    createdAt: '2026-09-01T10:00:00.000Z',
    pageTitle: 'TechVentures Application',
    pageUrl: 'https://apply.techventures.org/form',
    hostname: 'apply.techventures.org',
    submissionTitle: 'TechVentures Grant 2026',
    fields: [
      {
        id: 'f-name',
        label: 'Full Name',
        value: 'Ada Lovelace',
        fieldType: 'text',
        labelSource: 'label-for',
        excluded: false,
      },
      {
        id: 'f-email',
        label: 'Email Address',
        value: 'ada@example.com',
        fieldType: 'email',
        labelSource: 'label-for',
        excluded: false,
      },
      {
        id: 'f-desc',
        label: 'Project Description',
        value: 'Pioneering analytical computing engines.',
        fieldType: 'textarea',
        labelSource: 'label-for',
        excluded: false,
      },
      {
        id: 'f-budget',
        label: 'Requested Budget',
        value: '50000',
        fieldType: 'number',
        labelSource: 'label-for',
        excluded: false,
      },
    ],
    captureVersion: '0.1.0',
  };

  describe('A. Same form, identical labels', () => {
    it('successfully matches saved submission with 100% confidence', () => {
      const currentFields = [
        { label: 'Full Name', fieldType: 'text' },
        { label: 'Email Address', fieldType: 'email' },
        { label: 'Project Description', fieldType: 'textarea' },
        { label: 'Requested Budget', fieldType: 'number' },
      ];

      const result = matchForm('apply.techventures.org', currentFields, baseSavedSubmission);
      expect(result.isMatch).toBe(true);
      expect(result.confidence).toBe(1.0);
      expect(result.matchedFieldCount).toBe(4);
    });
  });

  describe('B. Same domain, different application form', () => {
    it('rejects matching an unrelated form on the same domain', () => {
      // Different form on same domain: e.g. a newsletter signup or contact form
      const newsletterFields = [{ label: 'Subscribe to Newsletter Email', fieldType: 'email' }];

      const result = matchForm('apply.techventures.org', newsletterFields, baseSavedSubmission);
      expect(result.isMatch).toBe(false);
      expect(result.confidence).toBeLessThan(0.5);
    });

    it('rejects matching a completely different careers application on the same domain', () => {
      const careersFields = [
        { label: 'Position Applied For', fieldType: 'select' },
        { label: 'Resume Upload', fieldType: 'file' },
        { label: 'Notice Period', fieldType: 'text' },
        { label: 'Salary Expectation', fieldType: 'number' },
      ];

      const result = matchForm('apply.techventures.org', careersFields, baseSavedSubmission);
      expect(result.isMatch).toBe(false);
      expect(result.matchedFieldCount).toBe(0);
    });
  });

  describe('C. Same logical form with one new field', () => {
    it('matches existing record and classifies the new field', () => {
      const currentFieldsWithNew = [
        { label: 'Full Name', fieldType: 'text' },
        { label: 'Email Address', fieldType: 'email' },
        { label: 'Project Description', fieldType: 'textarea' },
        { label: 'Requested Budget', fieldType: 'number' },
        { label: 'GitHub Profile', fieldType: 'url' }, // Newly added question
      ];

      const match = matchForm('apply.techventures.org', currentFieldsWithNew, baseSavedSubmission);
      expect(match.isMatch).toBe(true);
      expect(match.confidence).toBeGreaterThanOrEqual(0.8);
      expect(match.matchedFieldCount).toBe(4);

      // Verify merge classification identifies GitHub Profile as newly added
      const currentCaptured: CapturedField[] = [
        {
          id: 'c-1',
          label: 'Full Name',
          value: 'Ada Lovelace',
          fieldType: 'text',
          labelSource: 'label-for',
          excluded: false,
        },
        {
          id: 'c-2',
          label: 'Email Address',
          value: 'ada@example.com',
          fieldType: 'email',
          labelSource: 'label-for',
          excluded: false,
        },
        {
          id: 'c-3',
          label: 'Project Description',
          value: 'Pioneering analytical computing engines.',
          fieldType: 'textarea',
          labelSource: 'label-for',
          excluded: false,
        },
        {
          id: 'c-4',
          label: 'Requested Budget',
          value: '50000',
          fieldType: 'number',
          labelSource: 'label-for',
          excluded: false,
        },
        {
          id: 'c-5',
          label: 'GitHub Profile',
          value: 'https://github.com/adalovelace',
          fieldType: 'url',
          labelSource: 'label-for',
          excluded: false,
        },
      ];

      const merge = mergeSubmissions(baseSavedSubmission, currentCaptured);
      expect(merge.newCount).toBe(1);
      expect(merge.unchangedCount).toBe(4);
      expect(merge.changedCount).toBe(0);
      const newField = merge.diffs.find((d) => d.status === 'newly_added');
      expect(newField?.label).toBe('GitHub Profile');
      expect(newField?.newValue).toBe('https://github.com/adalovelace');
    });
  });

  describe('D. Same logical form where DOM order changes', () => {
    it('computes identical fingerprint regardless of control order in DOM', () => {
      const orderA = [
        { label: 'Full Name', fieldType: 'text' },
        { label: 'Email Address', fieldType: 'email' },
        { label: 'Project Description', fieldType: 'textarea' },
      ];

      const orderB = [
        { label: 'Project Description', fieldType: 'textarea' },
        { label: 'Full Name', fieldType: 'text' },
        { label: 'Email Address', fieldType: 'email' },
      ];

      const fpA = computeFormFingerprint('example.org', orderA);
      const fpB = computeFormFingerprint('example.org', orderB);
      expect(fpA).toBe(fpB);
    });

    it('matches answers accurately even when questions appear in inverted order', () => {
      const invertedFields = [
        { label: 'Requested Budget', fieldType: 'number' },
        { label: 'Project Description', fieldType: 'textarea' },
        { label: 'Email Address', fieldType: 'email' },
        { label: 'Full Name', fieldType: 'text' },
      ];

      const match = matchForm('apply.techventures.org', invertedFields, baseSavedSubmission);
      expect(match.isMatch).toBe(true);
      expect(match.confidence).toBe(1.0);
    });
  });

  describe('E. Label changes slightly but identity remains structurally strong', () => {
    it('matches field with minor punctuation or whitespace variation safely', () => {
      const target = { label: 'Full Name *', fieldType: 'text' };
      const candidates = baseSavedSubmission.fields;

      const matched = findFieldMatch(target, candidates);
      expect(matched).toBeDefined();
      expect(matched?.label).toBe('Full Name');
      expect(matched?.value).toBe('Ada Lovelace');
    });

    it('prefers leaving field untouched if label confidence is ambiguous', () => {
      const ambiguousTarget = { label: 'Favorite Color', fieldType: 'text' };
      const candidates = baseSavedSubmission.fields;

      const matched = findFieldMatch(ambiguousTarget, candidates);
      expect(matched).toBeUndefined();
    });
  });

  describe('F. Sensitive fields in stored/current form', () => {
    beforeEach(() => {
      document.body.innerHTML = `
        <form id="app-form">
          <label for="name">Full Name</label>
          <input type="text" id="name" />
          <label for="pwd">Password</label>
          <input type="password" id="pwd" />
          <label for="otp">Verification Code</label>
          <input type="text" id="otp" autocomplete="one-time-code" />
          <label for="card">Credit Card Number</label>
          <input type="text" id="card" autocomplete="cc-number" />
          <label for="cvv">CVV</label>
          <input type="text" id="cvv" name="cvv" />
          <input type="hidden" name="csrf" value="secret123" />
        </form>
      `;
    });

    it('never autofills passwords, OTP, credit card, CVV, or hidden fields', () => {
      const payload = {
        savedAnswers: [
          { label: 'Full Name', value: 'Ada Lovelace', fieldType: 'text' },
          { label: 'Password', value: 'SecretP@ssword123', fieldType: 'password' },
          { label: 'Verification Code', value: '123456', fieldType: 'text' },
          { label: 'Credit Card Number', value: '4111111111111111', fieldType: 'text' },
          { label: 'CVV', value: '999', fieldType: 'text' },
        ],
      };

      const result = injectedFillForm(payload);
      expect(result.filledCount).toBe(1); // Only Full Name filled
      expect(result.sensitiveSkippedCount).toBeGreaterThanOrEqual(4);

      const nameInput = document.getElementById('name') as HTMLInputElement;
      const pwdInput = document.getElementById('pwd') as HTMLInputElement;
      const otpInput = document.getElementById('otp') as HTMLInputElement;
      const cardInput = document.getElementById('card') as HTMLInputElement;
      const cvvInput = document.getElementById('cvv') as HTMLInputElement;

      expect(nameInput.value).toBe('Ada Lovelace');
      expect(pwdInput.value).toBe('');
      expect(otpInput.value).toBe('');
      expect(cardInput.value).toBe('');
      expect(cvvInput.value).toBe('');
    });
  });

  describe('G. Blank current field with old saved answer', () => {
    it('preserves previous stored value when current field is blank', () => {
      const currentWithBlank: CapturedField[] = [
        {
          id: 'c-1',
          label: 'Full Name',
          value: 'Ada Lovelace',
          fieldType: 'text',
          labelSource: 'label-for',
          excluded: false,
        },
        {
          id: 'c-2',
          label: 'Email Address',
          value: 'ada@example.com',
          fieldType: 'email',
          labelSource: 'label-for',
          excluded: false,
        },
        {
          id: 'c-3',
          label: 'Project Description',
          value: '', // User left blank on this visit
          fieldType: 'textarea',
          labelSource: 'label-for',
          excluded: false,
        },
        {
          id: 'c-4',
          label: 'Requested Budget',
          value: '50000',
          fieldType: 'number',
          labelSource: 'label-for',
          excluded: false,
        },
      ];

      const merge = mergeSubmissions(baseSavedSubmission, currentWithBlank);
      expect(merge.blankPreservedCount).toBe(1);
      const descDiff = merge.diffs.find((d) => d.label === 'Project Description');
      expect(descDiff?.status).toBe('blank_preserved');
      expect(descDiff?.finalValue).toBe('Pioneering analytical computing engines.');

      // Final merged fields still have the original value!
      const mergedDesc = merge.mergedFields.find((f) => f.label === 'Project Description');
      expect(mergedDesc?.value).toBe('Pioneering analytical computing engines.');
    });
  });

  describe('H. User changes one field', () => {
    it('updates only the changed field and preserves all other stored answers', () => {
      const currentWithChange: CapturedField[] = [
        {
          id: 'c-1',
          label: 'Full Name',
          value: 'Ada Lovelace',
          fieldType: 'text',
          labelSource: 'label-for',
          excluded: false,
        },
        {
          id: 'c-2',
          label: 'Email Address',
          value: 'ada.new@example.org', // CHANGED!
          fieldType: 'email',
          labelSource: 'label-for',
          excluded: false,
        },
        {
          id: 'c-3',
          label: 'Project Description',
          value: 'Pioneering analytical computing engines.',
          fieldType: 'textarea',
          labelSource: 'label-for',
          excluded: false,
        },
        {
          id: 'c-4',
          label: 'Requested Budget',
          value: '50000',
          fieldType: 'number',
          labelSource: 'label-for',
          excluded: false,
        },
      ];

      const merge = mergeSubmissions(baseSavedSubmission, currentWithChange);
      expect(merge.changedCount).toBe(1);
      expect(merge.unchangedCount).toBe(3);
      expect(merge.newCount).toBe(0);

      const emailDiff = merge.diffs.find((d) => d.label === 'Email Address');
      expect(emailDiff?.status).toBe('changed');
      expect(emailDiff?.oldValue).toBe('ada@example.com');
      expect(emailDiff?.newValue).toBe('ada.new@example.org');
      expect(emailDiff?.finalValue).toBe('ada.new@example.org');
    });
  });

  describe('I. Current page removed a former question', () => {
    it('preserves historical answers for fields no longer present in DOM', () => {
      // Current page only has Name, Email, Description (Budget was removed by form owner)
      const currentShort: CapturedField[] = [
        {
          id: 'c-1',
          label: 'Full Name',
          value: 'Ada Lovelace',
          fieldType: 'text',
          labelSource: 'label-for',
          excluded: false,
        },
        {
          id: 'c-2',
          label: 'Email Address',
          value: 'ada@example.com',
          fieldType: 'email',
          labelSource: 'label-for',
          excluded: false,
        },
        {
          id: 'c-3',
          label: 'Project Description',
          value: 'Pioneering analytical computing engines.',
          fieldType: 'textarea',
          labelSource: 'label-for',
          excluded: false,
        },
      ];

      const merge = mergeSubmissions(baseSavedSubmission, currentShort);
      expect(merge.missingPreservedCount).toBe(1);

      const budgetDiff = merge.diffs.find((d) => d.label === 'Requested Budget');
      expect(budgetDiff?.status).toBe('missing_preserved');
      expect(budgetDiff?.finalValue).toBe('50000');

      const mergedBudget = merge.mergedFields.find((f) => f.label === 'Requested Budget');
      expect(mergedBudget?.value).toBe('50000');
    });
  });

  describe('J. React-style controlled input simulation', () => {
    beforeEach(() => {
      document.body.innerHTML = `
        <form id="test-form">
          <label for="controlled-name">Full Name</label>
          <input type="text" id="controlled-name" />
          <label for="controlled-bio">Biography</label>
          <textarea id="controlled-bio"></textarea>
        </form>
      `;
    });

    it('emits bubbling input and change events when filling inputs', () => {
      const nameInput = document.getElementById('controlled-name') as HTMLInputElement;
      const bioTextarea = document.getElementById('controlled-bio') as HTMLTextAreaElement;

      let nameInputFired = false;
      let nameChangeFired = false;
      let bioInputFired = false;
      let bioChangeFired = false;

      nameInput.addEventListener('input', (e) => {
        if (e.bubbles) nameInputFired = true;
      });
      nameInput.addEventListener('change', (e) => {
        if (e.bubbles) nameChangeFired = true;
      });
      bioTextarea.addEventListener('input', (e) => {
        if (e.bubbles) bioInputFired = true;
      });
      bioTextarea.addEventListener('change', (e) => {
        if (e.bubbles) bioChangeFired = true;
      });

      injectedFillForm({
        savedAnswers: [
          { label: 'Full Name', value: 'Grace Hopper', fieldType: 'text' },
          { label: 'Biography', value: 'Pioneer of compiler design.', fieldType: 'textarea' },
        ],
      });

      expect(nameInput.value).toBe('Grace Hopper');
      expect(bioTextarea.value).toBe('Pioneer of compiler design.');
      expect(nameInputFired).toBe(true);
      expect(nameChangeFired).toBe(true);
      expect(bioInputFired).toBe(true);
      expect(bioChangeFired).toBe(true);
    });
  });

  describe('K. Radio group fill', () => {
    beforeEach(() => {
      document.body.innerHTML = `
        <fieldset>
          <legend>Experience Level</legend>
          <label><input type="radio" name="experience" value="junior" /> Junior</label>
          <label><input type="radio" name="experience" value="mid" /> Mid-level</label>
          <label><input type="radio" name="experience" value="senior" /> Senior</label>
        </fieldset>
      `;
    });

    it('selects the correct radio option by matching value or label', () => {
      const juniorRadio = document.querySelector('input[value="junior"]') as HTMLInputElement;
      const seniorRadio = document.querySelector('input[value="senior"]') as HTMLInputElement;

      injectedFillForm({
        savedAnswers: [{ label: 'Experience Level', value: 'senior', fieldType: 'radio' }],
      });

      expect(seniorRadio.checked).toBe(true);
      expect(juniorRadio.checked).toBe(false);
    });
  });

  describe('L. Select fill', () => {
    beforeEach(() => {
      document.body.innerHTML = `
        <label for="country">Country</label>
        <select id="country">
          <option value="">Select country...</option>
          <option value="US">United States</option>
          <option value="UK">United Kingdom</option>
          <option value="DE">Germany</option>
        </select>
      `;
    });

    it('selects the correct option by matching either option text or option value', () => {
      const select = document.getElementById('country') as HTMLSelectElement;

      injectedFillForm({
        savedAnswers: [{ label: 'Country', value: 'United Kingdom', fieldType: 'select' }],
      });

      expect(select.value).toBe('UK');
    });
  });

  describe('M. Checkbox fill', () => {
    beforeEach(() => {
      document.body.innerHTML = `
        <label for="agree">
          <input type="checkbox" id="agree" /> I agree to the terms
        </label>
      `;
    });

    it('checks the checkbox correctly when saved value indicates checked', () => {
      const checkbox = document.getElementById('agree') as HTMLInputElement;
      expect(checkbox.checked).toBe(false);

      injectedFillForm({
        savedAnswers: [{ label: 'I agree to the terms', value: 'Checked', fieldType: 'checkbox' }],
      });

      expect(checkbox.checked).toBe(true);
    });
  });

  describe('N. Migration and Versioning', () => {
    it('migrates older schemaVersion 1 submission to schemaVersion 2 with revisions and fingerprint', () => {
      const legacyV1: Submission = {
        id: 'legacy-01',
        schemaVersion: 1,
        createdAt: '2026-01-15T08:00:00.000Z',
        pageTitle: 'Old Accelerator Application',
        pageUrl: 'https://accelerator.example.com/apply',
        hostname: 'accelerator.example.com',
        submissionTitle: 'Old Accelerator Application',
        fields: [
          {
            id: 'f-1',
            label: 'Company Name',
            value: 'Acme AI',
            fieldType: 'text',
            labelSource: 'label-for',
            excluded: false,
          },
        ],
        captureVersion: '0.1.0',
      };

      const migrated = migrateSubmission(legacyV1);
      expect(migrated.schemaVersion).toBe(SCHEMA_VERSION);
      expect(migrated.updatedAt).toBe('2026-01-15T08:00:00.000Z');
      expect(migrated.formFingerprint).toBeDefined();
      expect(migrated.formFingerprint).toContain('fp_v2_');
      expect(migrated.revisions).toHaveLength(1);
      const firstRev = migrated.revisions?.[0];
      expect(firstRev?.changeNote).toBe('Initial capture');
    });
  });
});
