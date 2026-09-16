/**
 * Self-contained draft restoration script injected into the page context.
 * Safely restores saved draft fields only into empty matching fields.
 * Never overwrites non-empty user data or sensitive fields.
 */

export interface RestoreDraftOptions {
  draftFields: Record<string, { label: string; value: string; fieldType: string }>;
  showIndicator?: boolean;
}

export interface RestoreResult {
  restoredCount: number;
  skippedCount: number;
  totalDraftFields: number;
}

export function injectedRestoreDraft(options: RestoreDraftOptions): RestoreResult {
  const { draftFields = {}, showIndicator = true } = options;
  const draftEntries = Object.values(draftFields);
  if (draftEntries.length === 0) {
    return { restoredCount: 0, skippedCount: 0, totalDraftFields: 0 };
  }

  const SENSITIVE_AUTOCOMPLETE = [
    'current-password',
    'new-password',
    'one-time-code',
    'cc-number',
    'cc-csc',
    'cc-exp',
    'cc-exp-month',
    'cc-exp-year',
    'cc-type',
  ];

  const SENSITIVE_PATTERN =
    /password|passwd|pwd|otp|totp|mfa|cvv|cvc|card.?number|credit.?card|cc.?num|secret|token|auth.?token|ssn|social.?security|pin.?code|one.?time/i;

  function isSensitive(el: HTMLElement): boolean {
    if (el instanceof HTMLInputElement) {
      if (el.type === 'password' || el.type === 'hidden') return true;
      const ac = (el.autocomplete || '').toLowerCase();
      if (SENSITIVE_AUTOCOMPLETE.some((s) => ac.includes(s))) return true;
    }
    const name = el.getAttribute('name') || '';
    const id = el.id || '';
    const ariaLabel = el.getAttribute('aria-label') || '';
    if (
      SENSITIVE_PATTERN.test(name) ||
      SENSITIVE_PATTERN.test(id) ||
      SENSITIVE_PATTERN.test(ariaLabel)
    ) {
      return true;
    }
    return false;
  }

  function normalize(str: string): string {
    return (str || '')
      .toLowerCase()
      .replace(/[*?:!#\-_()[\]{}.,/\\<>]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function extractLabel(el: HTMLElement): string {
    if (el.id) {
      const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lbl && lbl.textContent?.trim()) return lbl.textContent.trim();
    }
    const wrap = el.closest('label');
    if (wrap && wrap.textContent?.trim()) return wrap.textContent.trim();
    const ariaLabelledBy = el.getAttribute('aria-labelledby');
    if (ariaLabelledBy) {
      const parts = ariaLabelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent?.trim() || '')
        .filter(Boolean);
      if (parts.length > 0) return parts.join(' ');
    }
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();
    const fieldset = el.closest('fieldset');
    if (fieldset) {
      const legend = fieldset.querySelector('legend');
      if (legend && legend.textContent?.trim()) return legend.textContent.trim();
    }
    const questionCard = el.closest(
      '[role="listitem"], .form-group, .question, .question-card, .field, .form-row, .field-wrapper',
    );
    if (questionCard) {
      const heading = questionCard.querySelector<HTMLElement>(
        'h1, h2, h3, h4, h5, h6, [role="heading"], .question-title, .field-label',
      );
      if (heading && heading.textContent?.trim() && !heading.contains(el)) {
        return heading.textContent.trim();
      }
    }
    const placeholder = el.getAttribute('placeholder');
    if (placeholder && placeholder.trim()) return placeholder.trim();
    const name = el.getAttribute('name');
    if (name && name.trim()) return name.trim();
    return el.id || '';
  }

  function getRadioGroupLabel(radio: HTMLElement): string {
    const container = radio.closest('[role="radiogroup"], [role="group"], fieldset');
    if (container) {
      const legend = container.querySelector('legend');
      if (legend && legend.textContent?.trim()) return legend.textContent.trim();
      const ariaLabel = container.getAttribute('aria-label');
      if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();
      const ariaLabelledBy = container.getAttribute('aria-labelledby');
      if (ariaLabelledBy) {
        const parts = ariaLabelledBy
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent?.trim() || '')
          .filter(Boolean);
        if (parts.length > 0) return parts.join(' ');
      }
      const heading = container.querySelector('h1, h2, h3, h4, h5, h6, [role="heading"]');
      if (heading && heading.textContent?.trim()) return heading.textContent.trim();
    }
    if (radio instanceof HTMLInputElement && radio.name) return radio.name;
    return extractLabel(radio);
  }

  function findMatchingDraft(
    label: string,
  ): { label: string; value: string; fieldType: string } | undefined {
    const norm = normalize(label);
    if (!norm) return undefined;
    for (const [key, field] of Object.entries(draftFields)) {
      if (normalize(key) === norm || normalize(field.label) === norm) {
        return field;
      }
    }
    return undefined;
  }

  // Prevent autosave while restoring values
  window.__submitlog_suppress_autosave = true;

  let restoredCount = 0;
  let skippedCount = 0;

  // 1. Inputs & Textareas
  const inputs = document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
    'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]), textarea',
  );

  const processedRadioGroups = new Set<string>();

  inputs.forEach((el) => {
    if (isSensitive(el)) {
      skippedCount++;
      return;
    }

    if (el instanceof HTMLInputElement && el.type === 'file') {
      return;
    }

    if (el instanceof HTMLInputElement && el.type === 'radio') {
      const groupName = el.name || 'unnamed-radio-group';
      if (processedRadioGroups.has(groupName)) return;
      processedRadioGroups.add(groupName);

      const groupLabel = getRadioGroupLabel(el);
      const match = findMatchingDraft(groupLabel);
      if (!match || !match.value) return;

      const radiosInGroup = document.querySelectorAll<HTMLInputElement>(
        `input[type="radio"][name="${CSS.escape(el.name)}"]`,
      );

      // Never overwrite if user already selected a radio
      const anyChecked = Array.from(radiosInGroup).some((r) => r.checked);
      if (anyChecked) {
        skippedCount++;
        return;
      }

      // Find matching radio by value or label
      let targetRadio: HTMLInputElement | null = null;
      for (const r of radiosInGroup) {
        const rVal = r.value || '';
        const rLabel = extractLabel(r);
        if (
          normalize(rVal) === normalize(match.value) ||
          normalize(rLabel) === normalize(match.value)
        ) {
          targetRadio = r;
          break;
        }
      }

      if (targetRadio) {
        targetRadio.checked = true;
        targetRadio.dispatchEvent(new Event('input', { bubbles: true }));
        targetRadio.dispatchEvent(new Event('change', { bubbles: true }));
        restoredCount++;
      }
      return;
    }

    if (el instanceof HTMLInputElement && el.type === 'checkbox') {
      const label = extractLabel(el);
      const match = findMatchingDraft(label);
      if (!match) return;

      const isChecked = match.value.toLowerCase() === 'checked';
      // Only set if not already set
      if (el.checked !== isChecked) {
        el.checked = isChecked;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        restoredCount++;
      }
      return;
    }

    // Text / textarea / number / etc.
    const currentVal = (el.value || '').trim();
    const label = extractLabel(el);
    const match = findMatchingDraft(label);

    if (!match || !match.value) return;

    // Safety rule: never overwrite non-empty user value unless identical
    if (currentVal !== '') {
      if (normalize(currentVal) === normalize(match.value)) {
        // Already matching
      } else {
        skippedCount++;
      }
      return;
    }

    // Field is empty: restore saved draft value!
    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (typeof setter === 'function') {
      setter.call(el, match.value);
    } else {
      el.value = match.value;
    }

    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    restoredCount++;
  });

  // 2. Select dropdowns
  const selects = document.querySelectorAll<HTMLSelectElement>('select');
  selects.forEach((sel) => {
    if (isSensitive(sel)) return;
    const label = extractLabel(sel);
    const match = findMatchingDraft(label);
    if (!match || !match.value) return;

    // If already has a non-default selection, skip
    if (sel.selectedIndex > 0) {
      skippedCount++;
      return;
    }

    const normVal = normalize(match.value);
    let matchedIndex = -1;
    for (let i = 0; i < sel.options.length; i++) {
      const opt = sel.options[i];
      if (opt && (normalize(opt.text) === normVal || normalize(opt.value) === normVal)) {
        matchedIndex = i;
        break;
      }
    }

    if (matchedIndex >= 0) {
      sel.selectedIndex = matchedIndex;
      sel.dispatchEvent(new Event('input', { bubbles: true }));
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      restoredCount++;
    }
  });

  setTimeout(() => {
    window.__submitlog_suppress_autosave = false;
  }, 500);

  // Show subtle non-intrusive notification indicator
  if (showIndicator && restoredCount > 0) {
    showRestoreNotification(restoredCount);
  }

  return {
    restoredCount,
    skippedCount,
    totalDraftFields: draftEntries.length,
  };
}

function showRestoreNotification(count: number): void {
  try {
    const existing = document.getElementById('submitlog-restore-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'submitlog-restore-toast';
    toast.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      z-index: 2147483645;
      background: #1d1d1f;
      color: #ffffff;
      padding: 8px 14px;
      border-radius: 6px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      font-size: 12px;
      font-weight: 500;
      box-shadow: 0 4px 12px rgba(0,0,0,0.25);
      pointer-events: none;
      opacity: 0;
      transform: translateY(6px);
      transition: opacity 0.2s ease, transform 0.2s ease;
    `;
    toast.textContent = `✓ Draft restored locally (${count} ${count === 1 ? 'field' : 'fields'})`;

    (document.documentElement || document.body).appendChild(toast);

    requestAnimationFrame(() => {
      toast.style.opacity = '1';
      toast.style.transform = 'translateY(0)';
    });

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(6px)';
      setTimeout(() => toast.remove(), 250);
    }, 2800);
  } catch {
    // Ignore notification failures
  }
}
