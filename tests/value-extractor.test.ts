import { describe, it, expect } from 'vitest';
import { extractValue, getFieldType } from '../src/capture/value-extractor';

describe('value-extractor', () => {
  describe('getFieldType', () => {
    it('should return textarea for textarea elements', () => {
      const el = document.createElement('textarea');
      expect(getFieldType(el)).toBe('textarea');
    });

    it('should return select for select elements', () => {
      const el = document.createElement('select');
      expect(getFieldType(el)).toBe('select');
    });

    it('should return correct type for input elements', () => {
      const types = ['text', 'email', 'tel', 'url', 'number', 'date', 'checkbox', 'radio', 'file'];
      for (const type of types) {
        const el = document.createElement('input');
        el.type = type;
        expect(getFieldType(el)).toBe(type);
      }
    });

    it('should return other for unknown input types', () => {
      const el = document.createElement('input');
      el.type = 'color';
      expect(getFieldType(el)).toBe('other');
    });
  });

  describe('extractValue', () => {
    it('should extract text input value', () => {
      const input = document.createElement('input');
      input.type = 'text';
      input.value = 'Hello World';
      expect(extractValue(input)).toBe('Hello World');
    });

    it('should normalize whitespace in values', () => {
      const input = document.createElement('input');
      input.type = 'text';
      input.value = '  Hello   World  ';
      expect(extractValue(input)).toBe('Hello World');
    });

    it('should return Checked for checked checkbox and empty string for unchecked', () => {
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = true;
      expect(extractValue(input)).toBe('Checked');

      input.checked = false;
      expect(extractValue(input)).toBe('');
    });

    it('should extract textarea value', () => {
      const textarea = document.createElement('textarea');
      textarea.value = 'Multi-line\ncontent here';
      expect(extractValue(textarea)).toBe('Multi-line content here');
    });

    it('should extract selected option text from select', () => {
      const select = document.createElement('select');
      const option1 = document.createElement('option');
      option1.text = 'United States';
      option1.value = 'US';
      const option2 = document.createElement('option');
      option2.text = 'United Kingdom';
      option2.value = 'UK';
      select.appendChild(option1);
      select.appendChild(option2);
      select.value = 'US';
      expect(extractValue(select)).toBe('United States');
    });

    it('should return empty string for file input with no files selected', () => {
      const input = document.createElement('input');
      input.type = 'file';
      expect(extractValue(input)).toBe('');
    });

    it('should return empty string for empty input', () => {
      const input = document.createElement('input');
      input.type = 'text';
      input.value = '';
      expect(extractValue(input)).toBe('');
    });
  });
});
