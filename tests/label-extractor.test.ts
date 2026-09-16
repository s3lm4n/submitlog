import { describe, it, expect } from 'vitest';
import { extractLabel } from '../src/capture/label-extractor';

describe('label-extractor', () => {
  describe('label[for] matching', () => {
    it('should extract label from label[for] element', () => {
      document.body.innerHTML = `
        <label for="name">Full Name</label>
        <input id="name" type="text" />
      `;
      const input = document.getElementById('name')!;
      const result = extractLabel(input, document);
      expect(result.label).toBe('Full Name');
      expect(result.source).toBe('label-for');
    });
  });

  describe('wrapping label', () => {
    it('should extract label from wrapping label element', () => {
      document.body.innerHTML = `
        <label>
          Email Address
          <input id="email" type="email" />
        </label>
      `;
      const input = document.getElementById('email')!;
      const result = extractLabel(input, document);
      expect(result.label).toBe('Email Address');
      expect(result.source).toBe('wrapping-label');
    });

    it('should not include input value in wrapping label text', () => {
      document.body.innerHTML = `
        <label>
          Your Name
          <input id="myname" type="text" value="John" />
        </label>
      `;
      const input = document.getElementById('myname')!;
      const result = extractLabel(input, document);
      expect(result.label).not.toContain('John');
      expect(result.source).toBe('wrapping-label');
    });
  });

  describe('aria-labelledby', () => {
    it('should extract label from aria-labelledby reference', () => {
      document.body.innerHTML = `
        <h3 id="question1">What is your favorite color?</h3>
        <input id="color" type="text" aria-labelledby="question1" />
      `;
      const input = document.getElementById('color')!;
      const result = extractLabel(input, document);
      expect(result.label).toBe('What is your favorite color?');
      expect(result.source).toBe('aria-labelledby');
    });
  });

  describe('aria-label', () => {
    it('should extract label from aria-label attribute', () => {
      document.body.innerHTML = `
        <input id="search" type="text" aria-label="Search submissions" />
      `;
      const input = document.getElementById('search')!;
      const result = extractLabel(input, document);
      expect(result.label).toBe('Search submissions');
      expect(result.source).toBe('aria-label');
    });
  });

  describe('placeholder fallback', () => {
    it('should use placeholder when no other label exists', () => {
      document.body.innerHTML = `
        <input id="company" type="text" placeholder="Enter company name" />
      `;
      const input = document.getElementById('company')!;
      const result = extractLabel(input, document);
      expect(result.label).toBe('Enter company name');
      expect(result.source).toBe('placeholder');
    });
  });

  describe('name fallback', () => {
    it('should use name attribute as fallback', () => {
      document.body.innerHTML = `
        <input name="company_name" type="text" />
      `;
      const input = document.querySelector('input')!;
      const result = extractLabel(input, document);
      expect(result.label).toBe('company_name');
      expect(result.source).toBe('name-fallback');
    });
  });

  describe('id fallback', () => {
    it('should use id as final fallback', () => {
      document.body.innerHTML = `
        <input id="field_123" type="text" />
      `;
      const input = document.getElementById('field_123')!;
      const result = extractLabel(input, document);
      expect(result.label).toBe('field_123');
      expect(result.source).toBe('id-fallback');
    });
  });

  describe('unknown', () => {
    it('should return Unknown Field when nothing available', () => {
      document.body.innerHTML = `
        <input type="text" />
      `;
      const input = document.querySelector('input')!;
      const result = extractLabel(input, document);
      expect(result.label).toBe('Unknown Field');
      expect(result.source).toBe('unknown');
    });
  });

  describe('whitespace normalization', () => {
    it('should normalize excessive whitespace', () => {
      document.body.innerHTML = `
        <label for="bio">Tell   us\n\nabout\t\tyourself</label>
        <textarea id="bio"></textarea>
      `;
      const input = document.getElementById('bio')!;
      const result = extractLabel(input, document);
      expect(result.label).toBe('Tell us about yourself');
    });
  });

  describe('label truncation', () => {
    it('should truncate labels longer than 500 characters', () => {
      const longText = 'A'.repeat(600);
      document.body.innerHTML = `
        <label for="long">${longText}</label>
        <input id="long" type="text" />
      `;
      const input = document.getElementById('long')!;
      const result = extractLabel(input, document);
      expect(result.label.length).toBeLessThanOrEqual(500);
      expect(result.label).toContain('...');
    });
  });

  describe('priority order', () => {
    it('should prefer label[for] over aria-label', () => {
      document.body.innerHTML = `
        <label for="field">Label For Text</label>
        <input id="field" type="text" aria-label="Aria Label Text" placeholder="Placeholder Text" />
      `;
      const input = document.getElementById('field')!;
      const result = extractLabel(input, document);
      expect(result.label).toBe('Label For Text');
      expect(result.source).toBe('label-for');
    });

    it('should prefer aria-labelledby over aria-label', () => {
      document.body.innerHTML = `
        <span id="ref">Referenced Text</span>
        <input id="field2" type="text" aria-labelledby="ref" aria-label="Aria Label" />
      `;
      const input = document.getElementById('field2')!;
      const result = extractLabel(input, document);
      expect(result.label).toBe('Referenced Text');
      expect(result.source).toBe('aria-labelledby');
    });
  });
});
