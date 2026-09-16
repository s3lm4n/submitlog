import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { captureFormData } from '../src/capture/capture-engine';
import { scanPageForms, capturePageForms } from '../src/capture/injected-capture';
import { checkFieldEligibility } from '../src/assistant/field-eligibility';

function loadFixture(filename: string): Document {
  const html = readFileSync(resolve(__dirname, 'fixtures', filename), 'utf-8');
  document.documentElement.innerHTML = html;
  return document;
}

describe('Real-World Form Detection & Answer Capture Regressions', () => {
  beforeEach(() => {
    document.documentElement.innerHTML = '';
  });

  describe('Scenario A: Mostly-Empty Real Application (SmartSimple style)', () => {
    it('detects a 10-question form structurally when only 1 question is answered', () => {
      const doc = loadFixture('mostly-empty-application.html');
      const result = captureFormData(doc, 'https://grants.smartsimple.example/apply');

      // Form detection must succeed based on structural evidence
      expect(result.formDetected).toBe(true);
      expect(result.totalDetected).toBeGreaterThanOrEqual(9);

      // Only the 1 populated answer should be captured
      expect(result.answeredCount).toBe(1);
      expect(result.includedCount).toBe(1);

      const captured = result.fields.filter((f) => !f.excluded);
      expect(captured).toHaveLength(1);
      expect(captured[0]?.label).toBe('Project Title');
      expect(captured[0]?.value).toBe('Decentralized Archival Protocol');
    });

    it('detects a completely blank application form without rejecting it', () => {
      const doc = loadFixture('mostly-empty-application.html');
      // Clear the one populated field
      const titleInput = doc.getElementById('projectTitle') as HTMLInputElement;
      if (titleInput) titleInput.value = '';

      const result = captureFormData(doc, 'https://grants.smartsimple.example/apply');

      // Form must still be detected as a real form
      expect(result.formDetected).toBe(true);
      expect(result.totalDetected).toBeGreaterThanOrEqual(9);
      expect(result.answeredCount).toBe(0);
      expect(result.includedCount).toBe(0);
      expect(result.fields).toHaveLength(0);
    });
  });

  describe('Scenario B: Div-based SPA Application (No native <form>)', () => {
    it('detects and captures forms rendered in div/section containers with workflow buttons', () => {
      const doc = loadFixture('div-based-spa-application.html');
      const result = captureFormData(doc, 'https://portal.enterprise.example/intake');

      expect(result.formDetected).toBe(true);
      expect(result.totalDetected).toBeGreaterThanOrEqual(4);
      expect(result.includedCount).toBe(4);

      const labels = result.fields.map((f) => f.label);
      expect(labels).toContain('Project Name');
      expect(labels).toContain('Executive Summary');
      expect(labels).toContain('Project Category');
      expect(labels).toContain('Estimated Budget');

      const categoryField = result.fields.find((f) => f.label === 'Project Category');
      expect(categoryField?.value).toBe('Infrastructure & Systems');
    });
  });

  describe('Scenario C: Form-Associated Controls Outside <form>', () => {
    it('groups controls outside <form> referencing it via [form] attribute', () => {
      const doc = loadFixture('form-associated-controls.html');
      const result = captureFormData(doc, 'https://proposals.example.org/new');

      expect(result.formDetected).toBe(true);
      expect(result.includedCount).toBe(4);

      const labels = result.fields.map((f) => f.label);
      // Inside form
      expect(labels).toContain('Proposal Title');
      expect(labels).toContain('Abstract');
      // Outside form (associated via form="proposal-form")
      expect(labels).toContain('Lead Organization');
      expect(labels).toContain('Budget Cap (USD)');

      const orgField = result.fields.find((f) => f.label === 'Lead Organization');
      expect(orgField?.value).toBe('Identity Research Org');
    });
  });

  describe('Scenario D: Multi-Step Application (Active visible step only)', () => {
    it('captures only the active visible step and excludes hidden inactive steps', () => {
      const doc = loadFixture('multi-step-application.html');
      const result = captureFormData(doc, 'https://fellowship.example.org/apply');

      expect(result.formDetected).toBe(true);
      expect(result.includedCount).toBe(4);

      const labels = result.fields.map((f) => f.label);
      // Step 1 (visible)
      expect(labels).toContain('Full Legal Name');
      expect(labels).toContain('Primary Email');
      expect(labels).toContain('Contact Phone');
      expect(labels).toContain('Short Biography');

      // Step 2 (hidden) must NOT be captured
      expect(labels).not.toContain('Current Institution');
      expect(labels).not.toContain('Highest Degree');

      const values = result.fields.map((f) => f.value);
      expect(values).not.toContain('Hidden University');
    });
  });

  describe('Scenario E: Application Form with Site Search', () => {
    it('selects the grant application and rejects the header search bar', () => {
      const doc = loadFixture('app-with-search.html');
      const result = captureFormData(doc, 'https://grants.example.org/apply');

      expect(result.formDetected).toBe(true);
      expect(result.includedCount).toBeGreaterThanOrEqual(4);

      const labels = result.fields.map((f) => f.label);
      expect(labels).toContain('Applicant Name');
      expect(labels).toContain('Proposal Summary');

      // Search bar must not be captured
      const hasSearch = result.fields.some(
        (f) =>
          f.label.toLowerCase().includes('search') || f.value.toLowerCase().includes('grants 2026'),
      );
      expect(hasSearch).toBe(false);
    });
  });

  describe('Scenario F: Pure Google-like Search / Utility Page', () => {
    it('strictly rejects search and utility controls as non-meaningful', () => {
      const doc = loadFixture('search-utility-page.html');
      const result = captureFormData(doc, 'https://search.example.com/');

      expect(result.formDetected).toBe(false);
      expect(result.totalDetected).toBe(0);
      expect(result.includedCount).toBe(0);
      expect(result.fields).toHaveLength(0);
    });
  });

  describe('Scenario G: Open Shadow DOM Form Controls', () => {
    it('traverses open Shadow DOM trees to discover component form fields', () => {
      document.body.innerHTML = `
        <div id="host"></div>
      `;
      const host = document.getElementById('host')!;
      const shadow = host.attachShadow({ mode: 'open' });
      shadow.innerHTML = `
        <div class="shadow-form" role="region" aria-label="Component Application">
          <label for="shadow-name">Applicant Name</label>
          <input type="text" id="shadow-name" value="Alex Turing" />

          <label for="shadow-project">Project Scope</label>
          <textarea id="shadow-project">Distributed cryptographic verification</textarea>

          <button type="button">Save and Submit</button>
        </div>
      `;

      const result = captureFormData(document, 'https://components.example.org/');

      expect(result.formDetected).toBe(true);
      expect(result.includedCount).toBe(2);

      const labels = result.fields.map((f) => f.label);
      expect(labels).toContain('Applicant Name');
      expect(labels).toContain('Project Scope');

      const nameField = result.fields.find((f) => f.label === 'Applicant Name');
      expect(nameField?.value).toBe('Alex Turing');
    });
  });

  describe('Scenario H: Embedded Iframes & Privacy-Safe Diagnostics', () => {
    it('detects embedded iframes when top frame has no forms', () => {
      const doc = loadFixture('iframe-application.html');
      const result = captureFormData(doc, 'https://portal.example.edu/');

      // Top frame has no native form, but contains an embedded iframe
      expect(result.formDetected).toBe(false);
      expect(result.inaccessibleFrameDetected).toBe(true);
    });

    it('generates privacy-safe diagnostics without user values or data leakage', () => {
      const doc = loadFixture('mostly-empty-application.html');
      const result = captureFormData(doc, 'https://grants.example.org/');

      expect(result.diagnostics).toBeDefined();
      expect(result.diagnostics?.candidateCount).toBeGreaterThanOrEqual(1);

      const jsonString = JSON.stringify(result.diagnostics);
      // Never leak user-entered data into diagnostics
      expect(jsonString).not.toContain('Decentralized Archival Protocol');
      expect(jsonString).not.toContain('applicant_email');
    });
  });

  describe('Scenario I: Google Forms / Modern Div-Heavy Application (No native <form>)', () => {
    it('detects div-based question cards, consolidates role="radio" radiogroup, cleans required markers, and rejects navigation/page indicators', () => {
      const doc = loadFixture('google-forms-style-application.html');
      const result = captureFormData(doc, 'https://forms.example.org/viewform');

      // 1. Meaningful form detected structurally
      expect(result.formDetected).toBe(true);
      expect(result.totalDetected).toBe(2);
      expect(result.answeredCount).toBe(2);
      expect(result.includedCount).toBe(2);

      // 2. Extracted labels must be cleaned of asterisk and "Required question"
      const labels = result.fields.map((f) => f.label);
      expect(labels).toContain('Email');
      expect(labels).toContain('Which program are you applying to?');
      expect(labels).not.toContain('Email *');
      expect(labels).not.toContain('Which program are you applying to? *');

      // 3. Extracted answers
      const emailField = result.fields.find((f) => f.label === 'Email');
      expect(emailField?.value).toBe('alice@innovate.org');
      expect(emailField?.fieldType).toBe('email');

      const programField = result.fields.find(
        (f) => f.label === 'Which program are you applying to?',
      );
      expect(programField?.value).toBe('Scale Accelerator');
      expect(programField?.fieldType).toBe('radio');

      // 4. Navigation buttons ("Next") and progress indicator ("Page 1 / 3") must NOT be captured as fields
      for (const field of result.fields) {
        expect(field.label).not.toMatch(/next/i);
        expect(field.label).not.toMatch(/page\s+1/i);
        expect(field.value).not.toMatch(/next/i);
        expect(field.value).not.toMatch(/page\s+1/i);
      }

      // 5. Field assistant attaches to eligible controls
      const emailInput = doc.querySelector<HTMLInputElement>('input[type="email"]')!;
      expect(emailInput).not.toBeNull();
      const eligibility = checkFieldEligibility(emailInput);
      expect(eligibility.eligible).toBe(true);
      expect(eligibility.label).toBe('Email');
      expect(eligibility.currentValue).toBe('alice@innovate.org');
    });

    it('detects a completely blank Google Forms style application without rejection', () => {
      const doc = loadFixture('google-forms-style-application.html');

      // Clear the text input
      const emailInput = doc.querySelector<HTMLInputElement>('input[type="email"]')!;
      emailInput.value = '';

      // Uncheck all radios
      const radios = doc.querySelectorAll<HTMLElement>('[role="radio"]');
      radios.forEach((r) => r.setAttribute('aria-checked', 'false'));

      const result = captureFormData(doc, 'https://forms.example.org/viewform');

      // Form must still be detected as a real form
      expect(result.formDetected).toBe(true);
      expect(result.totalDetected).toBe(2);
      expect(result.answeredCount).toBe(0);
      expect(result.includedCount).toBe(0);
      expect(result.fields).toHaveLength(0);
    });

    it('detects and captures correctly via injected scanPageForms and capturePageForms', () => {
      loadFixture('google-forms-style-application.html');

      const scan = scanPageForms();
      expect(scan.formDetected).toBe(true);
      expect(scan.totalFields).toBe(2);
      expect(scan.answeredCount).toBe(2);
      expect(scan.score).toBeGreaterThanOrEqual(30);

      const capture = capturePageForms();
      expect(capture.formDetected).toBe(true);
      expect(capture.totalDetected).toBe(2);
      expect(capture.answeredCount).toBe(2);
      expect(capture.fields).toHaveLength(2);

      const radioField = capture.fields.find((f) => f.fieldType === 'radio');
      expect(radioField?.label).toBe('Which program are you applying to?');
      expect(radioField?.value).toBe('Scale Accelerator');
    });

    it('confirms Google search and utility UI remains strictly rejected by both engine and injected scripts', () => {
      const doc = loadFixture('search-utility-page.html');
      const result = captureFormData(doc, 'https://search.example.com/');

      expect(result.formDetected).toBe(false);
      expect(result.totalDetected).toBe(0);

      const scan = scanPageForms();
      expect(scan.formDetected).toBe(false);

      const capture = capturePageForms();
      expect(capture.formDetected).toBe(false);
    });
  });
});
