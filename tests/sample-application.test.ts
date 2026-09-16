import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { captureFormData } from '../src/capture/capture-engine';

function loadSampleFixture(): Document {
  const html = readFileSync(resolve(__dirname, 'fixtures', 'sample-application.html'), 'utf-8');
  document.documentElement.innerHTML = html;
  return document;
}

describe('sample-application fixture end-to-end capture', () => {
  beforeEach(() => {
    loadSampleFixture();
  });

  it('captures all valid fields and excludes password and OTP', () => {
    const result = captureFormData(document, 'https://accelerator.example.com/apply');

    expect(result.pageTitle).toBe('TechVentures Accelerator Application');
    expect(result.hostname).toBe('accelerator.example.com');
    expect(result.pageUrl).toBe('https://accelerator.example.com/apply');

    // Check that excluded fields count is at least 2 (password and OTP)
    expect(result.excludedCount).toBeGreaterThanOrEqual(2);

    const includedFields = result.fields.filter((f) => !f.excluded);
    const excludedFields = result.fields.filter((f) => f.excluded);

    // Verify sensitive fields are properly marked as excluded
    const passwordField = excludedFields.find(
      (f) => f.label.toLowerCase().includes('password') || f.excludeReason?.includes('password'),
    );
    expect(passwordField).toBeDefined();
    expect(passwordField?.excluded).toBe(true);

    const otpField = excludedFields.find(
      (f) =>
        f.label.toLowerCase().includes('otp') ||
        f.label.toLowerCase().includes('verification') ||
        f.excludeReason?.includes('autocomplete'),
    );
    expect(otpField).toBeDefined();
    expect(otpField?.excluded).toBe(true);

    // Verify included fields have expected values
    const labels = includedFields.map((f) => f.label);
    expect(labels).toContain('Full name');
    expect(labels).toContain('Email');
    expect(labels).toContain('LinkedIn URL');
    expect(labels).toContain('GitHub URL');
    expect(labels).toContain('Company name');

    const fullNameField = includedFields.find((f) => f.label === 'Full name');
    expect(fullNameField?.value).toBe('Alice Founder');

    const emailField = includedFields.find((f) => f.label === 'Email');
    expect(emailField?.value).toBe('alice@startup.io');

    const companyField = includedFields.find((f) => f.label === 'Company name');
    expect(companyField?.value).toBe('NextGenTech');

    const problemField = includedFields.find((f) =>
      f.label.includes('What problem are you solving?'),
    );
    expect(problemField?.value).toContain('Developers forget what they submit');

    const countryField = includedFields.find((f) => f.label === 'Country');
    expect(countryField?.value).toBe('United States');

    const termsField = includedFields.find((f) =>
      f.label.includes('I agree to the terms and conditions'),
    );
    expect(termsField?.value).toBe('Checked');
  });
});
