import type { LabelSource } from '../models/submission';

export interface LabelResult {
  label: string;
  source: LabelSource;
}

function normalizeAndTruncate(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > 500 ? normalized.substring(0, 497) + '...' : normalized;
}

export function isLabelMeaningful(result: LabelResult): boolean {
  if (
    result.source === 'unknown' ||
    !result.label ||
    result.label.trim() === '' ||
    result.label === 'Unknown Field'
  ) {
    return false;
  }
  return true;
}

export function extractLabel(element: HTMLElement, document: Document): LabelResult {
  const id = element.id;
  if (id) {
    const labelFor = document.querySelector(`label[for="${CSS.escape(id)}"]`) as HTMLElement;
    if (labelFor && labelFor.textContent?.trim()) {
      return { label: normalizeAndTruncate(labelFor.textContent), source: 'label-for' };
    }
  }

  const wrappingLabel = element.closest('label');
  if (wrappingLabel && wrappingLabel.textContent?.trim()) {
    const clone = wrappingLabel.cloneNode(true) as HTMLElement;
    const innerInput = clone.querySelector('input, textarea, select');
    if (innerInput) {
      innerInput.remove();
    }
    const text = clone.textContent?.trim();
    if (text) {
      return { label: normalizeAndTruncate(text), source: 'wrapping-label' };
    }
  }

  const ariaLabelledby = element.getAttribute('aria-labelledby');
  if (ariaLabelledby) {
    const parts = ariaLabelledby
      .split(/\s+/)
      .map((refId) => document.getElementById(refId)?.textContent?.trim())
      .filter(Boolean);
    if (parts.length > 0) {
      return { label: normalizeAndTruncate(parts.join(' ')), source: 'aria-labelledby' };
    }
  }

  const ariaLabel = element.getAttribute('aria-label');
  if (ariaLabel?.trim()) {
    return { label: normalizeAndTruncate(ariaLabel), source: 'aria-label' };
  }

  // Check fieldset legend if inside fieldset
  const fieldset = element.closest('fieldset');
  if (fieldset) {
    const legend = fieldset.querySelector('legend');
    if (legend?.textContent?.trim()) {
      return { label: normalizeAndTruncate(legend.textContent), source: 'nearby-text' };
    }
  }

  // Previous sibling text
  const previousSibling = element.previousSibling;
  if (
    previousSibling &&
    previousSibling.nodeType === Node.TEXT_NODE &&
    previousSibling.textContent &&
    previousSibling.textContent.trim()
  ) {
    return { label: normalizeAndTruncate(previousSibling.textContent), source: 'nearby-text' };
  }

  // Previous sibling element if question-like
  const prevElem = element.previousElementSibling;
  if (prevElem && prevElem.textContent?.trim() && prevElem.textContent.trim().length < 200) {
    return { label: normalizeAndTruncate(prevElem.textContent), source: 'nearby-text' };
  }

  const placeholder = element.getAttribute('placeholder');
  if (placeholder?.trim()) {
    return { label: normalizeAndTruncate(placeholder), source: 'placeholder' };
  }

  const name = element.getAttribute('name');
  if (name?.trim()) {
    return { label: normalizeAndTruncate(name), source: 'name-fallback' };
  }

  if (id?.trim()) {
    return { label: normalizeAndTruncate(id), source: 'id-fallback' };
  }

  return { label: 'Unknown Field', source: 'unknown' };
}
