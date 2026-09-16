/**
 * Centralized guard to detect and handle private / incognito browsing windows.
 * SubmitLog strictly forbids capturing or storing any form data from private browsing.
 */

export interface PrivateBrowsingCheckResult {
  isPrivate: boolean;
  message?: string;
}

export const PRIVATE_BROWSING_MESSAGE =
  'SubmitLog does not archive forms from private browsing windows.';

export interface MinimalTabInfo {
  incognito?: boolean;
}

export function checkPrivateBrowsing(
  tab: MinimalTabInfo | null | undefined,
): PrivateBrowsingCheckResult {
  if (tab?.incognito) {
    return {
      isPrivate: true,
      message: PRIVATE_BROWSING_MESSAGE,
    };
  }
  return {
    isPrivate: false,
  };
}
