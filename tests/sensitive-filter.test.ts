import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { checkSensitiveField } from '../src/capture/sensitive-filter';

function loadFixture(name: string): Document {
  const html = readFileSync(resolve(__dirname, 'fixtures', name), 'utf-8');
  document.body.innerHTML = '';
  document.documentElement.innerHTML = html;
  return document;
}

describe('sensitive-filter', () => {
  describe('password fields', () => {
    it('should exclude type=password', () => {
      const input = document.createElement('input');
      input.type = 'password';
      const result = checkSensitiveField(input);
      expect(result.isSensitive).toBe(true);
      expect(result.reason).toContain('password');
    });

    it('should exclude autocomplete=current-password', () => {
      const input = document.createElement('input');
      input.type = 'text';
      input.setAttribute('autocomplete', 'current-password');
      const result = checkSensitiveField(input);
      expect(result.isSensitive).toBe(true);
    });

    it('should exclude autocomplete=new-password', () => {
      const input = document.createElement('input');
      input.type = 'text';
      input.setAttribute('autocomplete', 'new-password');
      const result = checkSensitiveField(input);
      expect(result.isSensitive).toBe(true);
    });

    it('should exclude fields with password in name', () => {
      const input = document.createElement('input');
      input.type = 'text';
      input.name = 'user_password';
      const result = checkSensitiveField(input);
      expect(result.isSensitive).toBe(true);
    });

    it('should exclude fields with pwd in id', () => {
      const input = document.createElement('input');
      input.type = 'text';
      input.id = 'confirm_pwd';
      const result = checkSensitiveField(input);
      expect(result.isSensitive).toBe(true);
    });
  });

  describe('OTP fields', () => {
    it('should exclude autocomplete=one-time-code', () => {
      const input = document.createElement('input');
      input.type = 'text';
      input.setAttribute('autocomplete', 'one-time-code');
      const result = checkSensitiveField(input);
      expect(result.isSensitive).toBe(true);
    });

    it('should exclude fields with otp in name', () => {
      const input = document.createElement('input');
      input.type = 'text';
      input.name = 'otp_code';
      const result = checkSensitiveField(input);
      expect(result.isSensitive).toBe(true);
    });

    it('should exclude fields with totp in name', () => {
      const input = document.createElement('input');
      input.type = 'text';
      input.name = 'totp_token';
      const result = checkSensitiveField(input);
      expect(result.isSensitive).toBe(true);
    });

    it('should exclude fields with mfa in id', () => {
      const input = document.createElement('input');
      input.type = 'text';
      input.id = 'mfa-code';
      const result = checkSensitiveField(input);
      expect(result.isSensitive).toBe(true);
    });
  });

  describe('payment fields', () => {
    it('should exclude autocomplete=cc-number', () => {
      const input = document.createElement('input');
      input.type = 'text';
      input.setAttribute('autocomplete', 'cc-number');
      const result = checkSensitiveField(input);
      expect(result.isSensitive).toBe(true);
    });

    it('should exclude autocomplete=cc-csc', () => {
      const input = document.createElement('input');
      input.type = 'text';
      input.setAttribute('autocomplete', 'cc-csc');
      const result = checkSensitiveField(input);
      expect(result.isSensitive).toBe(true);
    });

    it('should exclude fields with cvv in name', () => {
      const input = document.createElement('input');
      input.type = 'text';
      input.name = 'cvv';
      const result = checkSensitiveField(input);
      expect(result.isSensitive).toBe(true);
    });

    it('should exclude fields with cvc in name', () => {
      const input = document.createElement('input');
      input.type = 'text';
      input.name = 'card_cvc';
      const result = checkSensitiveField(input);
      expect(result.isSensitive).toBe(true);
    });

    it('should exclude fields with cardnumber in id', () => {
      const input = document.createElement('input');
      input.type = 'text';
      input.id = 'cardnumber';
      const result = checkSensitiveField(input);
      expect(result.isSensitive).toBe(true);
    });
  });

  describe('hidden fields', () => {
    it('should exclude type=hidden', () => {
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = 'csrf_token';
      const result = checkSensitiveField(input);
      expect(result.isSensitive).toBe(true);
    });
  });

  describe('other sensitive patterns', () => {
    it('should exclude fields with secret in name', () => {
      const input = document.createElement('input');
      input.type = 'text';
      input.name = 'api_secret';
      const result = checkSensitiveField(input);
      expect(result.isSensitive).toBe(true);
    });

    it('should exclude fields with token in id', () => {
      const input = document.createElement('input');
      input.type = 'text';
      input.id = 'auth_token';
      const result = checkSensitiveField(input);
      expect(result.isSensitive).toBe(true);
    });

    it('should exclude fields with ssn in name', () => {
      const input = document.createElement('input');
      input.type = 'text';
      input.name = 'ssn';
      const result = checkSensitiveField(input);
      expect(result.isSensitive).toBe(true);
    });

    it('should exclude fields with sensitive aria-label', () => {
      const input = document.createElement('input');
      input.type = 'text';
      input.setAttribute('aria-label', 'Enter your password');
      const result = checkSensitiveField(input);
      expect(result.isSensitive).toBe(true);
    });
  });

  describe('non-sensitive fields', () => {
    it('should NOT exclude normal text input', () => {
      const input = document.createElement('input');
      input.type = 'text';
      input.name = 'full_name';
      const result = checkSensitiveField(input);
      expect(result.isSensitive).toBe(false);
    });

    it('should NOT exclude email input', () => {
      const input = document.createElement('input');
      input.type = 'email';
      input.name = 'email';
      const result = checkSensitiveField(input);
      expect(result.isSensitive).toBe(false);
    });

    it('should NOT exclude textarea', () => {
      const textarea = document.createElement('textarea');
      textarea.name = 'description';
      const result = checkSensitiveField(textarea);
      expect(result.isSensitive).toBe(false);
    });

    it('should NOT exclude select element', () => {
      const select = document.createElement('select');
      select.name = 'country';
      const result = checkSensitiveField(select);
      expect(result.isSensitive).toBe(false);
    });

    it('should NOT exclude number input', () => {
      const input = document.createElement('input');
      input.type = 'number';
      input.name = 'amount';
      const result = checkSensitiveField(input);
      expect(result.isSensitive).toBe(false);
    });
  });

  describe('fixture: sensitive-fields.html', () => {
    beforeEach(() => {
      loadFixture('sensitive-fields.html');
    });

    it('should detect password fields in fixture', () => {
      const passwords = document.querySelectorAll('input[type="password"]');
      passwords.forEach((el) => {
        const result = checkSensitiveField(el as HTMLInputElement);
        expect(result.isSensitive).toBe(true);
      });
    });

    it('should NOT exclude username field in fixture', () => {
      const username = document.querySelector('input[name="username"]');
      if (username) {
        const result = checkSensitiveField(username as HTMLInputElement);
        expect(result.isSensitive).toBe(false);
      }
    });
  });
});
