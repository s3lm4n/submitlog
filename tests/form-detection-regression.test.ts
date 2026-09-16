import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { captureFormData } from '../src/capture/capture-engine';

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
});
