/**
 * Centralized guard for determining if a URL or tab is a capturable web page.
 * Browser internal pages, PDF viewers, and extension pages are protected by browser security
 * and must fail gracefully with a friendly message rather than producing unhandled errors.
 */

export const RESTRICTED_PAGE_MESSAGE = 'SubmitLog cannot capture forms on this browser page.';

const RESTRICTED_PREFIXES = [
  'chrome://',
  'chrome-extension://',
  'about:',
  'edge://',
  'opera://',
  'brave://',
  'moz-extension://',
  'view-source:',
  'data:',
  'javascript:',
];

export interface PageSupportResult {
  isSupported: boolean;
  message?: string;
}

export function checkPageSupported(rawUrl: string | undefined | null): PageSupportResult {
  if (!rawUrl) {
    return {
      isSupported: false,
      message: RESTRICTED_PAGE_MESSAGE,
    };
  }

  const lowerUrl = rawUrl.toLowerCase();
  for (const prefix of RESTRICTED_PREFIXES) {
    if (lowerUrl.startsWith(prefix)) {
      return {
        isSupported: false,
        message: RESTRICTED_PAGE_MESSAGE,
      };
    }
  }

  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return {
        isSupported: false,
        message: RESTRICTED_PAGE_MESSAGE,
      };
    }
  } catch {
    return {
      isSupported: false,
      message: RESTRICTED_PAGE_MESSAGE,
    };
  }

  return {
    isSupported: true,
  };
}
