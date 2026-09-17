import {
  isElementSensitive,
  SENSITIVE_PATTERNS as CANONICAL_PATTERNS,
  type SensitiveCheckResult,
} from '../security/sensitive-patterns';
import { extractLabel } from './label-extractor';

export type { SensitiveCheckResult };
export const SENSITIVE_PATTERNS = CANONICAL_PATTERNS;

export function checkSensitiveField(element: HTMLElement): SensitiveCheckResult {
  let labelText = '';
  try {
    if (element.ownerDocument) {
      const extracted = extractLabel(element, element.ownerDocument);
      labelText = extracted.label || '';
    }
  } catch {
    // ignore
  }
  return isElementSensitive(element, labelText);
}
