import { describe, it, expect } from 'vitest';
import {
  checkPrivateBrowsing,
  PRIVATE_BROWSING_MESSAGE,
} from '../src/security/private-browsing-guard';
import { checkPageSupported, RESTRICTED_PAGE_MESSAGE } from '../src/security/page-guard';

describe('security guards', () => {
  describe('checkPrivateBrowsing', () => {
    it('detects private/incognito tab when incognito is true', () => {
      const result = checkPrivateBrowsing({ incognito: true });
      expect(result.isPrivate).toBe(true);
      expect(result.message).toBe(PRIVATE_BROWSING_MESSAGE);
    });

    it('allows normal tabs when incognito is false', () => {
      const result = checkPrivateBrowsing({ incognito: false });
      expect(result.isPrivate).toBe(false);
      expect(result.message).toBeUndefined();
    });

    it('allows normal tabs when incognito is undefined', () => {
      const result = checkPrivateBrowsing({});
      expect(result.isPrivate).toBe(false);
    });

    it('handles null or undefined tab gracefully', () => {
      expect(checkPrivateBrowsing(null).isPrivate).toBe(false);
      expect(checkPrivateBrowsing(undefined).isPrivate).toBe(false);
    });
  });

  describe('checkPageSupported', () => {
    it('supports standard http and https pages', () => {
      expect(checkPageSupported('https://example.com/form').isSupported).toBe(true);
      expect(checkPageSupported('http://localhost:3000/apply').isSupported).toBe(true);
      expect(checkPageSupported('http://127.0.0.1:8080').isSupported).toBe(true);
    });

    it('blocks chrome:// internal pages', () => {
      const result = checkPageSupported('chrome://extensions');
      expect(result.isSupported).toBe(false);
      expect(result.message).toBe(RESTRICTED_PAGE_MESSAGE);
    });

    it('blocks about: internal pages (Firefox)', () => {
      const result = checkPageSupported('about:addons');
      expect(result.isSupported).toBe(false);
      expect(result.message).toBe(RESTRICTED_PAGE_MESSAGE);
    });

    it('blocks edge:// internal pages', () => {
      const result = checkPageSupported('edge://settings');
      expect(result.isSupported).toBe(false);
      expect(result.message).toBe(RESTRICTED_PAGE_MESSAGE);
    });

    it('blocks extension pages', () => {
      expect(checkPageSupported('chrome-extension://abcdef/popup.html').isSupported).toBe(false);
      expect(checkPageSupported('moz-extension://abcdef/popup.html').isSupported).toBe(false);
    });

    it('blocks view-source, data, and javascript URLs', () => {
      expect(checkPageSupported('view-source:https://example.com').isSupported).toBe(false);
      expect(checkPageSupported('data:text/html,<h1>test</h1>').isSupported).toBe(false);
      expect(checkPageSupported('javascript:alert(1)').isSupported).toBe(false);
    });

    it('handles empty, null, or invalid URLs gracefully', () => {
      expect(checkPageSupported('').isSupported).toBe(false);
      expect(checkPageSupported(null).isSupported).toBe(false);
      expect(checkPageSupported(undefined).isSupported).toBe(false);
      expect(checkPageSupported('not-a-valid-url').isSupported).toBe(false);
    });
  });
});
