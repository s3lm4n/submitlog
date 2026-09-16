export interface SensitiveCheckResult {
  isSensitive: boolean;
  reason?: string;
}

const SENSITIVE_PATTERNS =
  /password|passwd|pwd|otp|totp|mfa|cvv|cvc|cardnumber|card-number|cc-num|secret|token|auth_token|auth-token|authtoken|oauth|bearer|ssn|social-security/i;

export function checkSensitiveField(element: HTMLElement): SensitiveCheckResult {
  if (element instanceof HTMLInputElement) {
    if (element.type === 'password') {
      return { isSensitive: true, reason: 'Type is password' };
    }
    if (element.type === 'hidden') {
      return { isSensitive: true, reason: 'Type is hidden' };
    }
  }

  const autocomplete = element.getAttribute('autocomplete');
  if (autocomplete) {
    const autocompleteLower = autocomplete.toLowerCase();
    if (
      autocompleteLower.includes('password') ||
      autocompleteLower === 'one-time-code' ||
      autocompleteLower.includes('cc-number') ||
      autocompleteLower.includes('cc-csc') ||
      autocompleteLower.includes('cc-exp')
    ) {
      return { isSensitive: true, reason: 'Sensitive autocomplete attribute' };
    }
  }

  const name = element.getAttribute('name') || '';
  const id = element.getAttribute('id') || '';

  if (SENSITIVE_PATTERNS.test(name) || SENSITIVE_PATTERNS.test(id)) {
    return { isSensitive: true, reason: 'Sensitive pattern in name or id' };
  }

  const ariaLabel = element.getAttribute('aria-label') || '';
  if (SENSITIVE_PATTERNS.test(ariaLabel)) {
    return { isSensitive: true, reason: 'Sensitive pattern in aria-label' };
  }

  return { isSensitive: false };
}
