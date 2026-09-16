import { describe, it, expect } from 'vitest';
import { exportAsJson, exportAsMarkdown, exportAllAsJson } from '../src/export/exporter';
import type { Submission } from '../src/models/submission';

function createTestSubmission(overrides: Partial<Submission> = {}): Submission {
  return {
    id: 'test-id-123',
    schemaVersion: 1,
    createdAt: '2026-01-15T10:30:00.000Z',
    pageTitle: 'Test Application',
    pageUrl: 'https://example.com/apply',
    hostname: 'example.com',
    submissionTitle: 'Test Application - 1/15/2026',
    captureVersion: '0.1.0',
    fields: [
      {
        id: 'field-1',
        label: 'Full Name',
        value: 'Jane Doe',
        fieldType: 'text',
        labelSource: 'label-for',
        excluded: false,
      },
      {
        id: 'field-2',
        label: 'Email',
        value: 'jane@example.com',
        fieldType: 'email',
        labelSource: 'label-for',
        excluded: false,
      },
      {
        id: 'field-3',
        label: 'Password',
        value: '',
        fieldType: 'text',
        labelSource: 'name-fallback',
        excluded: true,
        excludeReason: 'Password field',
      },
    ],
    ...overrides,
  };
}

describe('exporter', () => {
  describe('exportAsJson', () => {
    it('should exclude excluded fields from JSON export', () => {
      const sub = createTestSubmission();
      const json = exportAsJson(sub);
      const parsed = JSON.parse(json);
      expect(parsed.fields).toHaveLength(2);
      expect(parsed.fields.every((f: { excluded: boolean }) => !f.excluded)).toBe(true);
    });

    it('should produce valid JSON', () => {
      const sub = createTestSubmission();
      const json = exportAsJson(sub);
      expect(() => JSON.parse(json)).not.toThrow();
    });

    it('should include submission metadata', () => {
      const sub = createTestSubmission();
      const json = exportAsJson(sub);
      const parsed = JSON.parse(json);
      expect(parsed.submissionTitle).toBe('Test Application - 1/15/2026');
      expect(parsed.hostname).toBe('example.com');
    });
  });

  describe('exportAsMarkdown', () => {
    it('should contain title as heading', () => {
      const sub = createTestSubmission();
      const md = exportAsMarkdown(sub);
      expect(md).toContain('# Test Application - 1/15/2026');
    });

    it('should contain site and URL info', () => {
      const sub = createTestSubmission();
      const md = exportAsMarkdown(sub);
      expect(md).toContain('example.com');
      expect(md).toContain('https://example.com/apply');
    });

    it('should only include non-excluded fields', () => {
      const sub = createTestSubmission();
      const md = exportAsMarkdown(sub);
      expect(md).toContain('Full Name');
      expect(md).toContain('Jane Doe');
      expect(md).not.toContain('Password');
    });

    it('should contain SubmitLog attribution', () => {
      const sub = createTestSubmission();
      const md = exportAsMarkdown(sub);
      expect(md).toContain('SubmitLog');
    });
  });

  describe('exportAllAsJson', () => {
    it('should export array of submissions with metadata', () => {
      const subs = [createTestSubmission(), createTestSubmission({ id: 'test-2' })];
      const json = exportAllAsJson(subs);
      const parsed = JSON.parse(json);
      expect(parsed.exportVersion).toBe(1);
      expect(parsed.count).toBe(2);
      expect(parsed.submissions).toHaveLength(2);
      expect(parsed.exportedAt).toBeDefined();
    });

    it('should filter excluded fields from all submissions', () => {
      const subs = [createTestSubmission()];
      const json = exportAllAsJson(subs);
      const parsed = JSON.parse(json);
      expect(parsed.submissions[0].fields).toHaveLength(2);
    });
  });
});
