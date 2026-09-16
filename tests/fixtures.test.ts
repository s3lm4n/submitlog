import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { captureFormData } from '../src/capture/capture-engine';

function loadFixtureDoc(filename: string): Document {
  const html = readFileSync(resolve(__dirname, 'fixtures', filename), 'utf-8');
  document.documentElement.innerHTML = html;
  return document;
}

describe('HTML Form Fixtures Capture', () => {
  it('captures traditional-form.html correctly', () => {
    const doc = loadFixtureDoc('traditional-form.html');
    const result = captureFormData(doc, 'https://example.com/contact');

    expect(result.pageTitle).toBe('Traditional Form');
    expect(result.includedCount).toBe(5);
    expect(result.excludedCount).toBe(0);

    const labels = result.fields.map((f) => f.label);
    expect(labels).toContain('Full Name:');
    expect(labels).toContain('Email:');
    expect(labels).toContain('Phone:');
    expect(labels).toContain('Address:');
    expect(labels).toContain('Country:');

    const nameField = result.fields.find((f) => f.label === 'Full Name:');
    expect(nameField?.value).toBe('John Doe');

    const countryField = result.fields.find((f) => f.label === 'Country:');
    expect(countryField?.value).toBe('United States');
  });

  it('captures aria-labels.html correctly', () => {
    const doc = loadFixtureDoc('aria-labels.html');
    const result = captureFormData(doc, 'https://example.com/aria');

    expect(result.pageTitle).toBe('ARIA Labels Form');
    const labels = result.fields.map((f) => f.label);
    expect(labels).toContain('First Name');
    expect(labels).toContain('Department Name');

    const fnameField = result.fields.find((f) => f.label === 'First Name');
    expect(fnameField?.labelSource).toBe('aria-label');
    expect(fnameField?.value).toBe('Jane');

    const deptField = result.fields.find((f) => f.label === 'Department Name');
    expect(deptField?.labelSource).toBe('aria-labelledby');
    expect(deptField?.value).toBe('Engineering');
  });

  it('captures checkbox-radio.html groups correctly', () => {
    const doc = loadFixtureDoc('checkbox-radio.html');
    const result = captureFormData(doc, 'https://example.com/choices');

    expect(result.pageTitle).toBe('Checkboxes and Radios');
    expect(result.includedCount).toBeGreaterThanOrEqual(2);

    const radioField = result.fields.find((f) => f.fieldType === 'radio');
    expect(radioField).toBeDefined();
    expect(radioField?.value).toBe('mid');

    const termsField = result.fields.find((f) => f.label.includes('I agree to terms'));
    expect(termsField?.value).toBe('Checked');
  });

  it('captures unlabeled-fields.html with heuristics', () => {
    const doc = loadFixtureDoc('unlabeled-fields.html');
    const result = captureFormData(doc, 'https://example.com/unlabeled');

    expect(result.pageTitle).toBe('Unlabeled Fields');
    // The completely unlabeled control with no identifier is excluded by policy
    expect(result.includedCount).toBe(4);

    const cityField = result.fields.find((f) => f.value === 'Seattle');
    expect(cityField?.label).toBe('city');
    expect(cityField?.labelSource).toBe('name-fallback');

    const zipField = result.fields.find((f) => f.value === '98101');
    expect(zipField?.label).toBe('zipcode');
    expect(zipField?.labelSource).toBe('id-fallback');

    const devField = result.fields.find((f) => f.value === 'Developer');
    expect(devField?.label).toBe('Enter your occupation');
    expect(devField?.labelSource).toBe('placeholder');

    const mysteryField = result.fields.find((f) => f.value === 'Mystery Value');
    expect(mysteryField).toBeUndefined();
  });
});
