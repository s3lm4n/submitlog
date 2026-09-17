/**
 * Self-contained form filling function for injection via browser.scripting.executeScript.
 * This function CANNOT import external modules - all logic must be completely self-contained.
 * Dispatches framework-compatible bubbling events using native property setters.
 * NEVER submits forms automatically. NEVER fills sensitive fields or file inputs.
 */

export interface SavedAnswerToFill {
  label: string;
  value: string;
  fieldType: string;
}

export interface FillPayload {
  savedAnswers: SavedAnswerToFill[];
}

export interface FillResult {
  filledCount: number;
  unmatchedSavedCount: number;
  sensitiveSkippedCount: number;
  details: Array<{
    label: string;
    status: 'filled' | 'unmatched' | 'skipped_sensitive' | 'skipped_file';
    reason?: string;
  }>;
}

export function injectedFillForm(payload: FillPayload): FillResult {
  (window as unknown as { __submitlog_suppress_autosave?: boolean }).__submitlog_suppress_autosave =
    true;

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
    'bday',
    'bday-day',
    'bday-month',
    'bday-year',
  ];

  const SENSITIVE_PATTERN =
    /password|passwd|pwd|passcode|otp|totp|mfa|2fa|cvv|cvc|csc|card.?number|credit.?card|cc.?num|secret|token|auth.?token|auth.?code|verification.?code|security.?code|pin.?code|pincode|one.?time|bank.?account|routing.?(?:num(?:ber)?|transit)|transit.?routing|aba.?routing|bank.?routing|iban|swift.?(?:code|bic|id|num(?:ber)?)|bic.?(?:swift|code)|(?:^|[^a-z0-9])bic(?:[0-9]*)(?:[^a-z0-9]|$)|tax.?id|taxpayer.?(?:id|identification)|date.?of.?birth|birth.?date|passport|driver.?s?.?lic(?:ense)?|driving.?lic(?:ense)?|ssn|social.?security|national.?(?:id|identity|insurance)|(?:^|[^a-z0-9])(?:dob|ein|tin)(?:[0-9]*)(?:[^a-z0-9]|$)/i;

  function isSensitiveText(text: string): boolean {
    if (!text) return false;
    if (SENSITIVE_PATTERN.test(text)) return true;
    const splitCamel = text.replace(/([a-z])([A-Z])/g, '$1 $2');
    if (SENSITIVE_PATTERN.test(splitCamel)) return true;
    const clean = text.replace(/[\s\-_]+/g, '');
    return SENSITIVE_PATTERN.test(clean);
  }

  function isSensitive(el: HTMLElement, extractedLabel?: string): boolean {
    if (el instanceof HTMLInputElement) {
      if (el.type === 'password' || el.type === 'hidden' || el.type === 'file') return true;
      const ac = (el.autocomplete || '').toLowerCase();
      if (SENSITIVE_AUTOCOMPLETE.some((s) => ac.includes(s))) return true;
    }
    const name = el.getAttribute('name') || '';
    const id = el.id || '';
    const ariaLabel = el.getAttribute('aria-label') || '';
    if (
      isSensitiveText(name) ||
      isSensitiveText(id) ||
      isSensitiveText(ariaLabel) ||
      (extractedLabel && isSensitiveText(extractedLabel))
    ) {
      return true;
    }
    return false;
  }

  function normalize(str: string): string {
    if (!str) return '';
    return str
      .toLowerCase()
      .replace(/[*:\-–—_?#]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function isFieldTypeCompatible(typeA: string, typeB: string): boolean {
    const a = (typeA || 'text').toLowerCase();
    const b = (typeB || 'text').toLowerCase();
    if (a === b) return true;
    const textTypes = new Set(['text', 'email', 'tel', 'url', 'number', 'date', 'other']);
    if (textTypes.has(a) && textTypes.has(b)) return true;
    if ((a === 'textarea' && textTypes.has(b)) || (b === 'textarea' && textTypes.has(a))) {
      return true;
    }
    return false;
  }

  function getRadioLabel(radio: HTMLInputElement): string {
    if (radio.id) {
      const lbl = document.querySelector(`label[for="${CSS.escape(radio.id)}"]`);
      if (lbl && lbl.textContent) return lbl.textContent.trim();
    }
    const wrap = radio.closest('label');
    if (wrap && wrap.textContent) return wrap.textContent.trim();
    const parent = radio.parentElement;
    if (parent && parent.textContent) return parent.textContent.trim();
    return radio.value || '';
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
    const placeholder = el.getAttribute('placeholder');
    if (placeholder && placeholder.trim()) return placeholder.trim();
    const name = el.getAttribute('name');
    if (name && name.trim()) return name.trim();
    return el.id || '';
  }

  function isVisible(el: HTMLElement): boolean {
    if (el.hasAttribute('hidden')) return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    if (el.style.display === 'none' || el.style.visibility === 'hidden') return false;
    const hiddenAncestor = el.closest(
      '[hidden], [aria-hidden="true"], [style*="display: none"], [style*="display:none"], [style*="visibility: hidden"], [style*="visibility:hidden"]',
    );
    if (hiddenAncestor) return false;
    try {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
    } catch {
      // Ignore
    }
    return true;
  }

  // Native property setters for React/Vue/Angular compatibility
  function setNativeValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
    const proto =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) {
      desc.set.call(element, value);
    } else {
      element.value = value;
    }
  }

  function setNativeSelect(select: HTMLSelectElement, value: string) {
    const valLower = value.trim().toLowerCase();
    let found = false;
    for (let i = 0; i < select.options.length; i++) {
      const opt = select.options[i];
      if (!opt) continue;
      if (
        opt.value.trim().toLowerCase() === valLower ||
        opt.text.trim().toLowerCase() === valLower
      ) {
        opt.selected = true;
        found = true;
        break;
      }
    }
    if (!found) {
      const desc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
      if (desc && desc.set) {
        desc.set.call(select, value);
      } else {
        select.value = value;
      }
    }
    select.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    select.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
  }

  function setNativeCheckbox(checkbox: HTMLInputElement, value: string) {
    const lower = value.trim().toLowerCase();
    const isChecked =
      lower === 'checked' ||
      lower === 'true' ||
      lower === 'yes' ||
      lower === 'on' ||
      lower === checkbox.value.trim().toLowerCase();

    const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked');
    if (desc && desc.set) {
      desc.set.call(checkbox, isChecked);
    } else {
      checkbox.checked = isChecked;
    }
    checkbox.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }));
    checkbox.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
  }

  function setNativeRadio(radio: HTMLInputElement) {
    const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked');
    if (desc && desc.set) {
      desc.set.call(radio, true);
    } else {
      radio.checked = true;
    }
    radio.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }));
    radio.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
  }

  const result: FillResult = {
    filledCount: 0,
    unmatchedSavedCount: 0,
    sensitiveSkippedCount: 0,
    details: [],
  };

  // Suppress autosave during programmatic fill
  (window as unknown as { __submitlog_suppress_autosave?: boolean }).__submitlog_suppress_autosave =
    true;

  const savedAnswers = payload.savedAnswers || [];
  const matchedSavedIndices = new Set<number>();

  // Collect all controls
  const allElements = Array.from(
    document.querySelectorAll<HTMLElement>('input, textarea, select'),
  ).filter(isVisible);

  // Group radio buttons by name
  const radioGroups = new Map<string, HTMLInputElement[]>();
  const nonRadioControls: HTMLElement[] = [];

  for (const el of allElements) {
    if (el instanceof HTMLInputElement && el.type === 'radio') {
      const name = el.name || `unnamed_radio_${el.id}`;
      let group = radioGroups.get(name);
      if (!group) {
        group = [];
        radioGroups.set(name, group);
      }
      group.push(el);
    } else {
      nonRadioControls.push(el);
    }
  }

  // 1. Process regular non-radio controls
  for (const el of nonRadioControls) {
    const isInput = el instanceof HTMLInputElement;
    const isTextArea = el instanceof HTMLTextAreaElement;
    const isSelect = el instanceof HTMLSelectElement;

    if (isInput && el.type === 'file') {
      result.details.push({
        label: extractLabel(el) || 'File Input',
        status: 'skipped_file',
        reason: 'File uploads cannot be autofilled for security and privacy',
      });
      continue;
    }

    const fieldLabel = extractLabel(el);
    if (isSensitive(el, fieldLabel)) {
      result.sensitiveSkippedCount++;
      result.details.push({
        label: fieldLabel || 'Sensitive Field',
        status: 'skipped_sensitive',
        reason: 'Excluded for security / sensitive field protection',
      });
      continue;
    }

    const normLabel = normalize(fieldLabel);
    if (!normLabel) continue;

    let fieldType = 'text';
    if (isTextArea) fieldType = 'textarea';
    else if (isSelect) fieldType = 'select';
    else if (isInput) fieldType = el.type || 'text';

    // Find best match in savedAnswers
    let matchedAnswer: SavedAnswerToFill | null = null;
    let matchedIdx = -1;

    for (let i = 0; i < savedAnswers.length; i++) {
      const ans = savedAnswers[i];
      if (!ans) continue;
      if (normalize(ans.label) === normLabel && isFieldTypeCompatible(fieldType, ans.fieldType)) {
        matchedAnswer = ans;
        matchedIdx = i;
        break;
      }
    }

    if (matchedAnswer && matchedAnswer.value) {
      matchedSavedIndices.add(matchedIdx);

      if (isInput && el.type === 'checkbox') {
        setNativeCheckbox(el, matchedAnswer.value);
      } else if (isSelect) {
        setNativeSelect(el, matchedAnswer.value);
      } else if (isInput || isTextArea) {
        setNativeValue(el, matchedAnswer.value);
        el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
        el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
      }

      result.filledCount++;
      result.details.push({
        label: fieldLabel,
        status: 'filled',
      });
    }
  }

  // 2. Process radio groups
  radioGroups.forEach((radios, groupName) => {
    // Check if any radio in group is sensitive
    if (radios.some((r) => isSensitive(r, groupName))) {
      result.sensitiveSkippedCount++;
      result.details.push({
        label: groupName,
        status: 'skipped_sensitive',
        reason: 'Excluded for security / sensitive field protection',
      });
      return;
    }

    // Determine group question/label
    const firstRadio = radios[0];
    if (!firstRadio) return;

    const groupContainer = firstRadio.closest('[role="radiogroup"], [role="group"], fieldset');
    let groupLabel = '';
    if (groupContainer) {
      const legend = groupContainer.querySelector('legend');
      if (legend && legend.textContent?.trim()) {
        groupLabel = legend.textContent.trim();
      } else {
        const ariaLabel = groupContainer.getAttribute('aria-label');
        if (ariaLabel && ariaLabel.trim()) groupLabel = ariaLabel.trim();
      }
    }
    if (!groupLabel) {
      groupLabel = groupName;
    }

    const normGroupLabel = normalize(groupLabel);

    // Find matching saved answer
    let matchedAnswer: SavedAnswerToFill | null = null;
    let matchedIdx = -1;

    for (let i = 0; i < savedAnswers.length; i++) {
      const ans = savedAnswers[i];
      if (!ans) continue;
      if (normalize(ans.label) === normGroupLabel) {
        matchedAnswer = ans;
        matchedIdx = i;
        break;
      }
    }

    if (matchedAnswer && matchedAnswer.value) {
      matchedSavedIndices.add(matchedIdx);
      const targetVal = matchedAnswer.value.trim().toLowerCase();

      for (const radio of radios) {
        const rVal = radio.value.trim().toLowerCase();
        const rLbl = getRadioLabel(radio).trim().toLowerCase();
        if (rVal === targetVal || rLbl === targetVal) {
          setNativeRadio(radio);
          result.filledCount++;
          result.details.push({
            label: groupLabel,
            status: 'filled',
          });
          break;
        }
      }
    }
  });

  // Count saved answers that had no matching field on page
  for (let i = 0; i < savedAnswers.length; i++) {
    if (!matchedSavedIndices.has(i)) {
      const ans = savedAnswers[i];
      if (ans) {
        result.unmatchedSavedCount++;
        result.details.push({
          label: ans.label,
          status: 'unmatched',
        });
      }
    }
  }

  setTimeout(() => {
    (
      window as unknown as { __submitlog_suppress_autosave?: boolean }
    ).__submitlog_suppress_autosave = false;
  }, 500);

  return result;
}
