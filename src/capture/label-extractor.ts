import type { LabelSource } from '../models/submission';

export interface LabelResult {
  label: string;
  source: LabelSource;
}

function normalizeAndTruncate(text: string): string {
  let cleaned = text
    .replace(/\s*Required question\s*/gi, '')
    .replace(/[\s*]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) cleaned = text.replace(/\s+/g, ' ').trim();
  return cleaned.length > 500 ? cleaned.substring(0, 497) + '...' : cleaned;
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

  // For radio buttons (native or ARIA role="radio"), check role="radiogroup" or role="group" container first
  const isRadio =
    (element instanceof HTMLInputElement && element.type === 'radio') ||
    element.getAttribute('role')?.toLowerCase() === 'radio';
  if (isRadio) {
    const groupContainer = element.closest('[role="radiogroup"], [role="group"]');
    if (groupContainer) {
      const groupAriaLabel = groupContainer.getAttribute('aria-label');
      if (groupAriaLabel?.trim()) {
        return { label: normalizeAndTruncate(groupAriaLabel), source: 'aria-label' };
      }
      const groupLabelledby = groupContainer.getAttribute('aria-labelledby');
      if (groupLabelledby) {
        const parts = groupLabelledby
          .split(/\s+/)
          .map((refId) => document.getElementById(refId)?.textContent?.trim())
          .filter(Boolean);
        if (parts.length > 0) {
          return { label: normalizeAndTruncate(parts.join(' ')), source: 'aria-labelledby' };
        }
      }
      const groupHeading = groupContainer.querySelector(
        'h1, h2, h3, h4, h5, h6, [role="heading"], .group-label',
      );
      if (groupHeading && groupHeading.textContent?.trim() && !groupHeading.contains(element)) {
        return {
          label: normalizeAndTruncate(groupHeading.textContent.trim()),
          source: 'nearby-text',
        };
      }
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

  // Check role="group" or role="radiogroup" aria-label
  const groupContainer = element.closest('[role="radiogroup"], [role="group"]');
  if (groupContainer) {
    const groupAriaLabel = groupContainer.getAttribute('aria-label');
    if (groupAriaLabel?.trim()) {
      return { label: normalizeAndTruncate(groupAriaLabel), source: 'aria-label' };
    }
    const groupLabelledby = groupContainer.getAttribute('aria-labelledby');
    if (groupLabelledby) {
      const parts = groupLabelledby
        .split(/\s+/)
        .map((refId) => document.getElementById(refId)?.textContent?.trim())
        .filter(Boolean);
      if (parts.length > 0) {
        return { label: normalizeAndTruncate(parts.join(' ')), source: 'aria-labelledby' };
      }
    }
  }

  // Check question heading in surrounding question card or row
  const questionCard = element.closest(
    '[role="listitem"], .form-group, .question, .question-card, .field, .form-row, .field-wrapper',
  );
  if (questionCard) {
    const heading = questionCard.querySelector<HTMLElement>(
      'h1, h2, h3, h4, h5, h6, [role="heading"], .question-title, .field-label',
    );
    if (heading && heading.textContent?.trim()) {
      const headingText = heading.textContent.trim();
      if (headingText.length < 250 && !heading.contains(element)) {
        return { label: normalizeAndTruncate(headingText), source: 'nearby-text' };
      }
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
