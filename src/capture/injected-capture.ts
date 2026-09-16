/**
 * Self-contained functions for injection via browser.scripting.executeScript.
 * These functions CANNOT import modules - all logic must be inlined.
 * They run in the web page's content script context.
 */

export interface InjectedCapturedField {
  id: string;
  label: string;
  value: string;
  fieldType: string;
  labelSource: string;
  excluded: boolean;
  excludeReason?: string;
}

export interface InjectedCaptureResult {
  fields: InjectedCapturedField[];
  excludedCount: number;
  totalDetected: number;
  includedCount: number;
}

/**
 * Scans the current page, finds form candidates, scores them, and returns the
 * capturable field count of the highest-scoring meaningful form candidate.
 * If only utility/search/empty forms exist, returns 0.
 */
export function countFormFields(): number {
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
    /password|passwd|pwd|otp|totp|mfa|cvv|cvc|cardnumber|card-number|card_number|cc-num|cc_num|secret|token|auth_token|ssn|social.?security|pin_code/i;

  const SEARCH_PATTERNS = /search|lookup|find|query|filter|nav|toolbar/i;
  const APPLICATION_PATTERNS =
    /app|apply|grant|register|signup|contact|proposal|inquiry|feedback|survey|checkout|order/i;
  const SUBMIT_BUTTON_PATTERNS = /submit|apply|send|save|register|complete|finish|continue|next/i;

  function isUtility(container: Element): boolean {
    const role = container.getAttribute('role')?.toLowerCase();
    if (role === 'search' || role === 'navigation' || role === 'toolbar' || role === 'menubar') {
      return true;
    }
    if (container.closest('nav, [role="navigation"], [role="toolbar"], [role="search"]')) {
      return true;
    }

    const inputs = Array.from(container.querySelectorAll('input'));
    const hasSearchInput = inputs.some(
      (inp) =>
        inp.type === 'search' ||
        inp.name === 'q' ||
        inp.name === 'query' ||
        inp.name === 'search' ||
        inp.getAttribute('aria-label')?.toLowerCase().includes('search'),
    );
    const textareas = container.querySelectorAll('textarea');
    if (hasSearchInput && inputs.length <= 3 && textareas.length === 0) {
      return true;
    }

    if (container instanceof HTMLFormElement) {
      const combined =
        `${container.getAttribute('action') || ''} ${container.getAttribute('name') || ''} ${container.id} ${container.className}`.toLowerCase();
      if (
        SEARCH_PATTERNS.test(combined) &&
        !APPLICATION_PATTERNS.test(combined) &&
        textareas.length === 0
      ) {
        if (inputs.length <= 3) return true;
      }
    }
    return false;
  }

  function isSensitive(el: HTMLElement): boolean {
    if (el instanceof HTMLInputElement) {
      if (el.type === 'password' || el.type === 'hidden') return true;
    }
    const autocomplete = (el.getAttribute('autocomplete') || '').toLowerCase();
    for (const p of SENSITIVE_AUTOCOMPLETE) {
      if (autocomplete.includes(p)) return true;
    }
    const combined = `${el.getAttribute('name') || ''} ${el.getAttribute('id') || ''} ${el.getAttribute('aria-label') || ''}`;
    return SENSITIVE_PATTERN.test(combined);
  }

  function isMeaningfulId(str: string): boolean {
    const clean = str.trim();
    if (!clean || clean.length < 2) return false;
    return !/^(input|field|ctrl|elem|control|form_field|txt|_)[0-9_]*$/i.test(clean);
  }

  function getLabelText(el: HTMLElement): string {
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l?.textContent?.trim()) return l.textContent.trim();
    }
    const wrap = el.closest('label');
    if (wrap?.textContent?.trim()) {
      const clone = wrap.cloneNode(true) as HTMLElement;
      clone.querySelectorAll('input, textarea, select').forEach((i) => i.remove());
      const t = clone.textContent?.trim();
      if (t) return t;
    }
    const ariaLabelledby = el.getAttribute('aria-labelledby');
    if (ariaLabelledby) {
      const parts = ariaLabelledby
        .split(/\s+/)
        .map((refId) => document.getElementById(refId)?.textContent?.trim())
        .filter(Boolean);
      if (parts.length > 0) return parts.join(' ');
    }
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel?.trim()) return ariaLabel.trim();

    const fieldset = el.closest('fieldset');
    if (fieldset) {
      const leg = fieldset.querySelector('legend');
      if (leg?.textContent?.trim()) return leg.textContent.trim();
    }

    const placeholder = el.getAttribute('placeholder');
    if (placeholder?.trim()) return placeholder.trim();

    const name = el.getAttribute('name');
    if (name && isMeaningfulId(name)) return name.trim();

    const id = el.getAttribute('id');
    if (id && isMeaningfulId(id)) return id.trim();

    return '';
  }

  function getFieldValue(el: HTMLElement): string {
    if (el instanceof HTMLInputElement) {
      if (el.type === 'checkbox') return el.checked ? 'Checked' : '';
      if (el.type === 'file') {
        return el.files && el.files.length > 0
          ? `${Array.from(el.files)
              .map((f) => f.name)
              .join(', ')} selected`
          : '';
      }
      return el.value.trim();
    }
    if (el instanceof HTMLTextAreaElement) {
      return el.value.trim();
    }
    if (el instanceof HTMLSelectElement) {
      const opts = Array.from(el.selectedOptions);
      if (opts.length === 1 && opts[0]) {
        if (!opts[0].value && /select|choose|none|^--/i.test(opts[0].text)) return '';
        return opts[0].text.trim();
      }
      return opts
        .map((o) => o.text)
        .join(', ')
        .trim();
    }
    return '';
  }

  // Find candidate containers
  const forms = Array.from(document.querySelectorAll('form'));
  let containers: Element[] = forms;
  if (containers.length === 0) {
    const roleForms = Array.from(document.querySelectorAll('[role="form"]'));
    if (roleForms.length > 0) {
      containers = roleForms;
    } else {
      const main = document.querySelector('main');
      if (main && main.querySelectorAll('input, textarea, select').length >= 2) {
        containers = [main];
      } else {
        containers = [document.body || document.documentElement];
      }
    }
  }

  let bestCount = 0;
  let bestScore = -999;

  for (const container of containers) {
    if (isUtility(container)) continue;

    const elements = Array.from(
      container.querySelectorAll<HTMLElement>(
        'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]), textarea, select',
      ),
    );

    let count = 0;
    let score = 0;
    let textareaCount = 0;
    const seenRadioGroups = new Set<string>();

    for (const el of elements) {
      if (isSensitive(el)) continue;

      const label = getLabelText(el);
      if (!label) continue; // Unknown Field Policy

      if (el instanceof HTMLInputElement && el.type === 'radio' && el.name) {
        if (seenRadioGroups.has(el.name)) continue;
        seenRadioGroups.add(el.name);
        const checked = container.querySelector(
          `input[type="radio"][name="${CSS.escape(el.name)}"]:checked`,
        );
        if (!checked) continue; // Unselected radio -> omit
        count++;
        score += 15;
        continue;
      }

      const val = getFieldValue(el);
      if (!val) continue; // Empty Field Policy

      count++;
      if (el instanceof HTMLTextAreaElement) {
        textareaCount++;
        score += 25;
      } else {
        score += 10;
      }
    }

    if (count >= 3) score += 20;
    if (textareaCount >= 2) score += 30;

    if (container instanceof HTMLFormElement) {
      const idAndClass = `${container.id} ${container.className}`.toLowerCase();
      if (APPLICATION_PATTERNS.test(idAndClass)) score += 25;
      const submitBtn = container.querySelector(
        'button[type="submit"], input[type="submit"], button:not([type])',
      );
      if (submitBtn) {
        const btnText = (
          submitBtn.textContent ||
          (submitBtn as HTMLInputElement).value ||
          ''
        ).trim();
        if (SUBMIT_BUTTON_PATTERNS.test(btnText)) score += 25;
      }
    }

    if (count < 2 && textareaCount === 0) score -= 40;

    // Minimum score threshold
    if (score >= 30 && count >= 1 && score > bestScore) {
      bestScore = score;
      bestCount = count;
    }
  }

  return bestCount;
}

/**
 * Captures form fields from the highest-scoring meaningful form candidate on the current page.
 * Strictly ignores utility/search forms, empty optional fields, empty file inputs, and unknown fields.
 */
export function capturePageForms(): InjectedCaptureResult {
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
    /password|passwd|pwd|otp|totp|mfa|cvv|cvc|cardnumber|card-number|card_number|cc-num|cc_num|secret|token|auth_token|ssn|social.?security|pin_code/i;

  const SEARCH_PATTERNS = /search|lookup|find|query|filter|nav|toolbar/i;
  const APPLICATION_PATTERNS =
    /app|apply|grant|register|signup|contact|proposal|inquiry|feedback|survey|checkout|order/i;
  const SUBMIT_BUTTON_PATTERNS = /submit|apply|send|save|register|complete|finish|continue|next/i;

  function isUtility(container: Element): boolean {
    const role = container.getAttribute('role')?.toLowerCase();
    if (role === 'search' || role === 'navigation' || role === 'toolbar' || role === 'menubar') {
      return true;
    }
    if (container.closest('nav, [role="navigation"], [role="toolbar"], [role="search"]')) {
      return true;
    }

    const inputs = Array.from(container.querySelectorAll('input'));
    const hasSearchInput = inputs.some(
      (inp) =>
        inp.type === 'search' ||
        inp.name === 'q' ||
        inp.name === 'query' ||
        inp.name === 'search' ||
        inp.getAttribute('aria-label')?.toLowerCase().includes('search'),
    );
    const textareas = container.querySelectorAll('textarea');
    if (hasSearchInput && inputs.length <= 3 && textareas.length === 0) {
      return true;
    }

    if (container instanceof HTMLFormElement) {
      const combined =
        `${container.getAttribute('action') || ''} ${container.getAttribute('name') || ''} ${container.id} ${container.className}`.toLowerCase();
      if (
        SEARCH_PATTERNS.test(combined) &&
        !APPLICATION_PATTERNS.test(combined) &&
        textareas.length === 0
      ) {
        if (inputs.length <= 3) return true;
      }
    }
    return false;
  }

  function isSensitive(el: HTMLElement): boolean {
    if (el instanceof HTMLInputElement) {
      if (el.type === 'password' || el.type === 'hidden') return true;
    }
    const autocomplete = (el.getAttribute('autocomplete') || '').toLowerCase();
    for (const p of SENSITIVE_AUTOCOMPLETE) {
      if (autocomplete.includes(p)) return true;
    }
    const combined = `${el.getAttribute('name') || ''} ${el.getAttribute('id') || ''} ${el.getAttribute('aria-label') || ''}`;
    return SENSITIVE_PATTERN.test(combined);
  }

  function isMeaningfulId(str: string): boolean {
    const clean = str.trim();
    if (!clean || clean.length < 2) return false;
    return !/^(input|field|ctrl|elem|control|form_field|txt|_)[0-9_]*$/i.test(clean);
  }

  function normalizeText(text: string): string {
    const normalized = text.replace(/\s+/g, ' ').trim();
    return normalized.length > 500 ? normalized.substring(0, 497) + '...' : normalized;
  }

  function getLabelInfo(el: HTMLElement): { label: string; source: string } {
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l?.textContent?.trim()) {
        return { label: normalizeText(l.textContent), source: 'label-for' };
      }
    }
    const wrap = el.closest('label');
    if (wrap?.textContent?.trim()) {
      const clone = wrap.cloneNode(true) as HTMLElement;
      clone.querySelectorAll('input, textarea, select').forEach((i) => i.remove());
      const t = clone.textContent?.trim();
      if (t) return { label: normalizeText(t), source: 'wrapping-label' };
    }
    const ariaLabelledby = el.getAttribute('aria-labelledby');
    if (ariaLabelledby) {
      const parts = ariaLabelledby
        .split(/\s+/)
        .map((refId) => document.getElementById(refId)?.textContent?.trim())
        .filter(Boolean);
      if (parts.length > 0) {
        return { label: normalizeText(parts.join(' ')), source: 'aria-labelledby' };
      }
    }
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel?.trim()) {
      return { label: normalizeText(ariaLabel), source: 'aria-label' };
    }

    const fieldset = el.closest('fieldset');
    if (fieldset) {
      const leg = fieldset.querySelector('legend');
      if (leg?.textContent?.trim()) {
        return { label: normalizeText(leg.textContent), source: 'nearby-text' };
      }
    }

    const placeholder = el.getAttribute('placeholder');
    if (placeholder?.trim()) {
      return { label: normalizeText(placeholder), source: 'placeholder' };
    }

    const name = el.getAttribute('name');
    if (name && isMeaningfulId(name)) {
      return { label: normalizeText(name), source: 'name-fallback' };
    }

    const id = el.getAttribute('id');
    if (id && isMeaningfulId(id)) {
      return { label: normalizeText(id), source: 'id-fallback' };
    }

    return { label: '', source: 'unknown' };
  }

  function getFieldValue(el: HTMLElement): string {
    if (el instanceof HTMLInputElement) {
      if (el.type === 'checkbox') return el.checked ? 'Checked' : '';
      if (el.type === 'file') {
        return el.files && el.files.length > 0
          ? `${Array.from(el.files)
              .map((f) => f.name)
              .join(', ')} selected`
          : '';
      }
      return el.value.replace(/\s+/g, ' ').trim();
    }
    if (el instanceof HTMLTextAreaElement) {
      return el.value.replace(/\s+/g, ' ').trim();
    }
    if (el instanceof HTMLSelectElement) {
      const opts = Array.from(el.selectedOptions);
      if (opts.length === 1 && opts[0]) {
        if (!opts[0].value && /select|choose|none|^--/i.test(opts[0].text)) return '';
        return opts[0].text.trim();
      }
      return opts
        .map((o) => o.text)
        .join(', ')
        .trim();
    }
    return '';
  }

  // Find candidate containers
  const forms = Array.from(document.querySelectorAll('form'));
  let containers: Element[] = forms;
  if (containers.length === 0) {
    const roleForms = Array.from(document.querySelectorAll('[role="form"]'));
    if (roleForms.length > 0) {
      containers = roleForms;
    } else {
      const main = document.querySelector('main');
      if (main && main.querySelectorAll('input, textarea, select').length >= 2) {
        containers = [main];
      } else {
        containers = [document.body || document.documentElement];
      }
    }
  }

  interface CandidateResult {
    fields: InjectedCapturedField[];
    score: number;
    excludedCount: number;
  }

  const candidateResults: CandidateResult[] = [];

  for (const container of containers) {
    if (isUtility(container)) continue;

    const elements = Array.from(
      container.querySelectorAll<HTMLElement>(
        'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]), textarea, select',
      ),
    );

    const fields: InjectedCapturedField[] = [];
    let excludedCount = 0;
    let score = 0;
    let textareaCount = 0;
    const seenRadioGroups = new Set<string>();

    for (const el of elements) {
      if (isSensitive(el)) {
        excludedCount++;
        const labelInfo = getLabelInfo(el);
        const fType =
          el instanceof HTMLTextAreaElement
            ? 'textarea'
            : el instanceof HTMLSelectElement
              ? 'select'
              : (el as HTMLInputElement).type || 'text';
        fields.push({
          id: crypto.randomUUID(),
          label: labelInfo.label || 'Sensitive Field',
          value: '',
          fieldType: fType,
          labelSource: labelInfo.source || 'unknown',
          excluded: true,
          excludeReason: 'Sensitive field excluded for privacy',
        });
        continue;
      }

      const labelInfo = getLabelInfo(el);
      if (!labelInfo.label) continue; // Unknown Field Policy: exclude unlabeled controls

      // Radio group consolidation
      if (el instanceof HTMLInputElement && el.type === 'radio' && el.name) {
        if (seenRadioGroups.has(el.name)) continue;
        seenRadioGroups.add(el.name);

        const radios = container.querySelectorAll<HTMLInputElement>(
          `input[type="radio"][name="${CSS.escape(el.name)}"]`,
        );
        const checked = Array.from(radios).find((r) => r.checked);
        if (!checked) continue; // Unselected radio group -> omit

        const checkedLabel = getLabelInfo(checked);
        const radioVal = checkedLabel.label || checked.value || 'Selected';

        fields.push({
          id: crypto.randomUUID(),
          label: labelInfo.label,
          value: radioVal,
          fieldType: 'radio',
          labelSource: labelInfo.source,
          excluded: false,
        });
        score += 15;
        continue;
      }

      // Checkbox group consolidation if multiple with same name
      if (el instanceof HTMLInputElement && el.type === 'checkbox' && el.name) {
        const sameName = container.querySelectorAll<HTMLInputElement>(
          `input[type="checkbox"][name="${CSS.escape(el.name)}"]`,
        );
        if (sameName.length > 1) {
          // Check if already processed
          if (fields.some((f) => f.label === labelInfo.label)) continue;
          const checkedBoxes = Array.from(sameName).filter((c) => c.checked);
          if (checkedBoxes.length === 0) continue; // Unchecked group -> omit

          const checkedVals = checkedBoxes.map((c) => {
            const l = getLabelInfo(c);
            return l.label || c.value;
          });

          fields.push({
            id: crypto.randomUUID(),
            label: labelInfo.label,
            value: checkedVals.join(', '),
            fieldType: 'checkbox',
            labelSource: labelInfo.source,
            excluded: false,
          });
          score += 15;
          continue;
        }
      }

      const val = getFieldValue(el);
      if (!val) continue; // Empty Field Policy: omit empty inputs

      const fType =
        el instanceof HTMLTextAreaElement
          ? 'textarea'
          : el instanceof HTMLSelectElement
            ? 'select'
            : (el as HTMLInputElement).type || 'text';

      fields.push({
        id: crypto.randomUUID(),
        label: labelInfo.label,
        value: val,
        fieldType: fType,
        labelSource: labelInfo.source,
        excluded: false,
      });

      if (el instanceof HTMLTextAreaElement) {
        textareaCount++;
        score += 25;
      } else {
        score += 10;
      }
    }

    if (fields.length >= 3) score += 20;
    if (fields.length >= 6) score += 25;
    if (textareaCount >= 2) score += 30;

    if (container instanceof HTMLFormElement) {
      const idAndClass = `${container.id} ${container.className}`.toLowerCase();
      if (APPLICATION_PATTERNS.test(idAndClass)) score += 25;
      const submitBtn = container.querySelector(
        'button[type="submit"], input[type="submit"], button:not([type])',
      );
      if (submitBtn) {
        const btnText = (
          submitBtn.textContent ||
          (submitBtn as HTMLInputElement).value ||
          ''
        ).trim();
        if (SUBMIT_BUTTON_PATTERNS.test(btnText)) score += 25;
      }
    }

    if (fields.length < 2 && textareaCount === 0) score -= 40;

    if (score >= 30 && fields.length >= 1) {
      candidateResults.push({
        fields,
        score,
        excludedCount,
      });
    }
  }

  if (candidateResults.length === 0) {
    return {
      fields: [],
      excludedCount: 0,
      totalDetected: 0,
      includedCount: 0,
    };
  }

  candidateResults.sort((a, b) => b.score - a.score);
  const winner = candidateResults[0];
  if (!winner) {
    return {
      fields: [],
      excludedCount: 0,
      totalDetected: 0,
      includedCount: 0,
    };
  }

  const included = winner.fields.filter((f) => !f.excluded);

  return {
    fields: winner.fields,
    excludedCount: winner.excludedCount,
    totalDetected: winner.fields.length,
    includedCount: included.length,
  };
}
