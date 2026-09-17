/**
 * Single authoritative source of truth for sensitive field patterns and detection.
 * Protects credentials, payment data, financial identifiers, and government/identity PII.
 */

export const SENSITIVE_PATTERNS =
  /password|passwd|pwd|passcode|otp|totp|mfa|2fa|cvv|cvc|csc|card.?number|credit.?card|cc.?num|secret|token|auth.?token|auth.?code|verification.?code|security.?code|pin.?code|pincode|one.?time|bank.?account|routing.?(?:num(?:ber)?|transit)|transit.?routing|aba.?routing|bank.?routing|iban|swift.?(?:code|bic|id|num(?:ber)?)|bic.?(?:swift|code)|(?:^|[^a-z0-9])bic(?:[0-9]*)(?:[^a-z0-9]|$)|tax.?id|taxpayer.?(?:id|identification)|date.?of.?birth|birth.?date|passport|driver.?s?.?lic(?:ense)?|driving.?lic(?:ense)?|ssn|social.?security|national.?(?:id|identity|insurance)|(?:^|[^a-z0-9])(?:dob|ein|tin)(?:[0-9]*)(?:[^a-z0-9]|$)/i;

export const SENSITIVE_AUTOCOMPLETE = [
  'current-password',
  'new-password',
  'one-time-code',
  'cc-number',
  'cc-csc',
  'cc-exp',
  'cc-exp-month',
  'cc-exp-year',
  'cc-type',
  'bday',
  'bday-day',
  'bday-month',
  'bday-year',
];

export interface SensitiveCheckResult {
  isSensitive: boolean;
  reason?: string;
}

/**
 * Checks whether a given string (name, id, label, or aria-label) matches sensitive patterns.
 */
export function isSensitiveText(text: string): boolean {
  if (!text) return false;
  if (SENSITIVE_PATTERNS.test(text)) return true;
  const splitCamel = text.replace(/([a-z])([A-Z])/g, '$1 $2');
  if (SENSITIVE_PATTERNS.test(splitCamel)) return true;
  const clean = text.replace(/[\s\-_]+/g, '');
  return SENSITIVE_PATTERNS.test(clean);
}

/**
 * Checks whether an HTML element is sensitive based on type, autocomplete, identifiers, and label.
 */
export function isElementSensitive(
  element: HTMLElement,
  extractedLabel?: string,
): SensitiveCheckResult {
  if (element instanceof HTMLInputElement) {
    const type = (element.type || '').toLowerCase();
    if (type === 'password') {
      return { isSensitive: true, reason: 'Type is password' };
    }
    if (type === 'hidden') {
      return { isSensitive: true, reason: 'Type is hidden' };
    }
  }

  const autocomplete = element.getAttribute('autocomplete');
  if (autocomplete) {
    const lower = autocomplete.toLowerCase();
    if (SENSITIVE_AUTOCOMPLETE.some((item) => lower.includes(item))) {
      return { isSensitive: true, reason: 'Sensitive autocomplete attribute' };
    }
  }

  const name = element.getAttribute('name') || '';
  const id = element.id || '';
  const ariaLabel = element.getAttribute('aria-label') || '';

  if (isSensitiveText(name)) {
    return { isSensitive: true, reason: 'Sensitive pattern in name' };
  }
  if (isSensitiveText(id)) {
    return { isSensitive: true, reason: 'Sensitive pattern in id' };
  }
  if (isSensitiveText(ariaLabel)) {
    return { isSensitive: true, reason: 'Sensitive pattern in aria-label' };
  }

  if (extractedLabel && isSensitiveText(extractedLabel)) {
    return { isSensitive: true, reason: 'Sensitive pattern in label' };
  }

  return { isSensitive: false };
}
