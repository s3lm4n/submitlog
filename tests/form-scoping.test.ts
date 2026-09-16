import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { captureFormData } from '../src/capture/capture-engine';
import { isUtilityForm, scoreFormCandidate } from '../src/capture/form-scorer';

function loadFixtureDoc(filename: string): Document {
  const html = readFileSync(resolve(__dirname, 'fixtures', filename), 'utf-8');
  document.documentElement.innerHTML = html;
  return document;
}

describe('Form Scoping and Noise Filtering', () => {
  describe('A. Search & Utility Page Rejection', () => {
    it('rejects search and utility pages completely', () => {
      const doc = loadFixtureDoc('search-utility-page.html');
      const result = captureFormData(doc, 'https://search.example.com/');

      // Must produce 0 fields / no meaningful submission form
      expect(result.includedCount).toBe(0);
      expect(result.fields).toHaveLength(0);
    });

    it('identifies role=search and search inputs as utility forms', () => {
      const doc = loadFixtureDoc('search-utility-page.html');
      const searchForm = doc.getElementById('search-form');
      expect(searchForm).not.toBeNull();
      expect(isUtilityForm(searchForm!)).toBe(true);

      const scoreResult = scoreFormCandidate(searchForm!, []);
      expect(scoreResult.isMeaningful).toBe(false);
      expect(scoreResult.score).toBeLessThanOrEqual(0);
    });
  });

  describe('B. Page with Real Application Form + Site Search', () => {
    it('captures ONLY the application form and excludes the search bar', () => {
      const doc = loadFixtureDoc('app-with-search.html');
      const result = captureFormData(doc, 'https://grants.example.org/apply');

      expect(result.includedCount).toBeGreaterThanOrEqual(4);

      const capturedLabels = result.fields.map((f) => f.label);
      // Application fields must be present
      expect(capturedLabels).toContain('Applicant Name');
      expect(capturedLabels).toContain('Contact Email');
      expect(capturedLabels).toContain('Project Title');
      expect(capturedLabels).toContain('Proposal Summary');
      expect(capturedLabels).toContain('Requested Budget (USD)');

      // Search field must NOT be captured
      const hasSearch = result.fields.some(
        (f) =>
          f.label.toLowerCase().includes('search') || f.value.toLowerCase().includes('grants 2026'),
      );
      expect(hasSearch).toBe(false);
    });
  });

  describe('C. Empty File Input and Unlabeled Input Exclusion', () => {
    it('excludes empty file inputs and unlabeled controls', () => {
      const doc = loadFixtureDoc('empty-and-unlabeled.html');
      const result = captureFormData(doc, 'https://feedback.example.com/');

      // Only the 2 valid fields (Your Name, Feedback) should be captured
      expect(result.includedCount).toBe(2);

      const labels = result.fields.map((f) => f.label);
      expect(labels).toContain('Your Name');
      expect(labels).toContain('Feedback');

      // Empty file input must NOT appear as "No file selected"
      const hasFile = result.fields.some(
        (f) =>
          f.label.toLowerCase().includes('attachment') ||
          f.value.toLowerCase().includes('no file selected') ||
          f.fieldType === 'file',
      );
      expect(hasFile).toBe(false);

      // Unlabeled input must NOT appear as "Unknown Field"
      const hasUnknown = result.fields.some(
        (f) => f.label === 'Unknown Field' || f.value.includes('Orphaned Text Without Label'),
      );
      expect(hasUnknown).toBe(false);
    });
  });

  describe('D. Two Unrelated Forms on Same Page', () => {
    it('scopes capture to the primary candidate and does NOT merge unrelated forms', () => {
      const doc = loadFixtureDoc('two-unrelated-forms.html');
      const result = captureFormData(doc, 'https://company.example.com/careers');

      // The major job application form should win over the single-field newsletter form
      expect(result.includedCount).toBe(4);

      const labels = result.fields.map((f) => f.label);
      expect(labels).toContain('Full Name');
      expect(labels).toContain('Email');
      expect(labels).toContain('Phone');
      expect(labels).toContain('Why are you a fit for this role?');

      // Newsletter email from the unrelated form must NOT be merged into the job application
      const values = result.fields.map((f) => f.value);
      expect(values).toContain('alex.rivera@example.com');
      expect(values).not.toContain('subscriber@example.com');
    });
  });
});
