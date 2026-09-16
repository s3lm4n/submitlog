/**
 * Self-contained functions for injected event-delegated autosave.
 * Injected via browser.scripting.executeScript into the page context.
 * Cannot import external modules.
 */

export interface ArmAutosaveOptions {
  editingSessionId: string;
  formFingerprint?: string;
  origin?: string;
  hostname: string;
  pathname?: string;
  pageTitle: string;
  pageUrl: string;
  matchingSubmissionId?: string | null;
  initialFields: Array<{ label: string; fieldType: string; excluded?: boolean }>;
}

export interface InjectedAutosaveStatus {
  active: boolean;
  editingSessionId?: string;
}

// Window state augmentations
declare global {
  interface Window {
    __submitlog_autosave_active?: boolean;
    __submitlog_autosave_session?: ArmAutosaveOptions;
    __submitlog_autosave_cleanup?: () => void;
    __submitlog_autosave_flush?: () => void;
    __submitlog_suppress_autosave?: boolean;
  }
}

/**
 * Arms autosave event listeners on document using event delegation.
 * Listens for input (debounced 100ms), change (prompt flush 50ms), focusout/blur (prompt flush 100ms),
 * periodic safety flush (2.5s), visibilitychange, and pagehide.
 */
export function injectedArmAutosave(options: ArmAutosaveOptions): { success: boolean } {
  // Disarm any prior listeners before re-arming
  if (typeof window.__submitlog_autosave_cleanup === 'function') {
    window.__submitlog_autosave_cleanup();
  }

  window.__submitlog_autosave_active = true;
  window.__submitlog_autosave_session = options;

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
    const card = radio.closest('[role="listitem"], .question-card, .question, .form-group, .field');
    if (card) {
      const heading = card.querySelector<HTMLElement>(
        'h1, h2, h3, h4, h5, h6, [role="heading"], .question-title, .field-label',
      );
      if (heading && heading.textContent?.trim()) return heading.textContent.trim();
    }
    if (radio instanceof HTMLInputElement && radio.name) return radio.name;
    return extractLabel(radio);
  }

  function getRadioValue(radio: HTMLElement): string {
    if (radio.id) {
      const lbl = document.querySelector(`label[for="${CSS.escape(radio.id)}"]`);
      if (lbl && lbl.textContent?.trim()) return lbl.textContent.trim();
    }
    const wrap = radio.closest('label');
    if (wrap && wrap.textContent?.trim()) return wrap.textContent.trim();
    return (
      radio.getAttribute('aria-label') ||
      radio.getAttribute('data-value') ||
      (radio instanceof HTMLInputElement ? radio.value : radio.textContent?.trim()) ||
      ''
    );
  }

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let safetyInterval: ReturnType<typeof setInterval> | null = null;
  let pendingFieldPayload: { label: string; value: string; fieldType: string } | null = null;
  const lastDispatchedValues = new Map<string, string>();

  function flushPending() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (!pendingFieldPayload) return;

    const payloadToSend = pendingFieldPayload;
    const lastVal = lastDispatchedValues.get(payloadToSend.label);
    if (lastVal === payloadToSend.value) {
      pendingFieldPayload = null;
      return;
    }

    lastDispatchedValues.set(payloadToSend.label, payloadToSend.value);
    pendingFieldPayload = null;

    try {
      const g = globalThis as unknown as {
        browser?: {
          runtime?: { sendMessage?: (msg: unknown, cb?: (res: unknown) => void) => void };
        };
        chrome?: {
          runtime?: { sendMessage?: (msg: unknown, cb?: (res: unknown) => void) => void };
        };
      };
      const runtime = g.browser?.runtime || g.chrome?.runtime || null;

      if (runtime && typeof runtime.sendMessage === 'function') {
        const origin = options.origin || window.location.origin;
        const pathname = options.pathname || window.location.pathname;

        runtime.sendMessage(
          {
            type: 'SUBMITLOG_AUTOSAVE_FIELD',
            payload: {
              editingSessionId: options.editingSessionId,
              origin,
              hostname: options.hostname,
              pathname,
              pageTitle: options.pageTitle,
              pageUrl: options.pageUrl,
              formFingerprint: options.formFingerprint,
              matchingSubmissionId: options.matchingSubmissionId,
              field: payloadToSend,
              allCurrentFields: options.initialFields,
            },
          },
          (res: unknown) => {
            if (
              res &&
              typeof res === 'object' &&
              'submissionId' in res &&
              typeof res.submissionId === 'string'
            ) {
              options.matchingSubmissionId = res.submissionId;
              if (window.__submitlog_autosave_session) {
                window.__submitlog_autosave_session.matchingSubmissionId = res.submissionId;
              }
            }
          },
        );
      }
    } catch {
      // Ignore background communication failures
    }
  }

  window.__submitlog_autosave_flush = flushPending;

  function processElementChange(target: HTMLElement, delayMs = 100) {
    if (window.__submitlog_suppress_autosave) return;
    if (isSensitive(target)) return;

    const isInput = target instanceof HTMLInputElement;
    const isTextArea = target instanceof HTMLTextAreaElement;
    const isSelect = target instanceof HTMLSelectElement;
    const role = target.getAttribute('role')?.toLowerCase();
    const isAriaRadio = role === 'radio';
    const isAriaCheckbox = role === 'checkbox';
    const isAriaTextbox = role === 'textbox';
    const isEditable = target.isContentEditable && !target.parentElement?.isContentEditable;

    if (
      !isInput &&
      !isTextArea &&
      !isSelect &&
      !isAriaRadio &&
      !isAriaCheckbox &&
      !isAriaTextbox &&
      !isEditable
    ) {
      return;
    }
    if (isInput && target.type === 'file') return;
    if (
      isInput &&
      (target.type === 'submit' || target.type === 'button' || target.type === 'reset')
    ) {
      return;
    }

    let fieldType = 'text';
    let label = '';
    let value = '';

    if ((isInput && target.type === 'radio') || isAriaRadio) {
      const isChecked = isInput
        ? target.checked
        : target.getAttribute('aria-checked') === 'true' ||
          target.classList.contains('checked') ||
          target.classList.contains('is-checked');
      if (!isChecked) return; // Only autosave the chosen radio
      fieldType = 'radio';
      label = getRadioGroupLabel(target);
      value = getRadioValue(target);
    } else if ((isInput && target.type === 'checkbox') || isAriaCheckbox) {
      fieldType = 'checkbox';
      label = extractLabel(target);
      const isChecked = isInput
        ? target.checked
        : target.getAttribute('aria-checked') === 'true' ||
          target.classList.contains('checked') ||
          target.classList.contains('is-checked');
      value = isChecked ? 'Checked' : 'Not checked';
    } else if (isSelect) {
      fieldType = 'select';
      label = extractLabel(target);
      const opt = target.options[target.selectedIndex];
      value = opt ? opt.text.trim() || opt.value.trim() : target.value;
    } else if (isTextArea) {
      fieldType = 'textarea';
      label = extractLabel(target);
      value = target.value;
    } else if (isAriaTextbox || isEditable) {
      fieldType = 'text';
      label = extractLabel(target);
      value = target.textContent?.trim() || '';
    } else if (isInput) {
      fieldType = target.type || 'text';
      label = extractLabel(target);
      value = target.value;
    }

    if (!label.trim()) return;

    pendingFieldPayload = {
      label: label.trim(),
      value: value.trim(),
      fieldType,
    };

    if (delayMs <= 0) {
      flushPending();
    } else {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
      debounceTimer = setTimeout(() => {
        flushPending();
      }, delayMs);
    }
  }

  // Event handlers
  const handleInputEvent = (e: Event) => {
    const target = e.target as HTMLElement | null;
    if (
      target &&
      (target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target.getAttribute('role') === 'textbox' ||
        target.isContentEditable)
    ) {
      // Debounced write: 100ms after last keystroke
      processElementChange(target, 100);
    }
  };

  const handleFocusOut = (e: FocusEvent) => {
    const target = e.target as HTMLElement | null;
    if (
      target &&
      (target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target.getAttribute('role') === 'textbox' ||
        target.isContentEditable)
    ) {
      // Prompt flush on blur / focusout: 100ms
      processElementChange(target, 100);
    }
  };

  const handleChange = (e: Event) => {
    const target = e.target as HTMLElement | null;
    if (target && (target instanceof HTMLSelectElement || target instanceof HTMLInputElement)) {
      // Prompt flush on change: 50ms
      processElementChange(target, 50);
    }
  };

  const handleClick = (e: MouseEvent) => {
    const target = e.target as HTMLElement | null;
    const radioOrCheckbox = target?.closest<HTMLElement>('[role="radio"], [role="checkbox"]');
    if (radioOrCheckbox) {
      setTimeout(() => processElementChange(radioOrCheckbox, 0), 50);
    }
  };

  const handleSubmit = () => {
    flushPending();
  };

  const handleVisibilityChange = () => {
    if (document.visibilityState === 'hidden') {
      flushPending();
    }
  };

  const handlePageHide = () => {
    flushPending();
  };

  // Periodic safety flush every 2.5s when dirty
  safetyInterval = setInterval(() => {
    if (pendingFieldPayload) {
      flushPending();
    }
  }, 2500);

  document.addEventListener('input', handleInputEvent, true);
  document.addEventListener('focusout', handleFocusOut, true);
  document.addEventListener('change', handleChange, true);
  document.addEventListener('click', handleClick, true);
  document.addEventListener('submit', handleSubmit, true);
  document.addEventListener('visibilitychange', handleVisibilityChange, true);
  window.addEventListener('pagehide', handlePageHide, true);

  window.__submitlog_autosave_cleanup = () => {
    document.removeEventListener('input', handleInputEvent, true);
    document.removeEventListener('focusout', handleFocusOut, true);
    document.removeEventListener('change', handleChange, true);
    document.removeEventListener('click', handleClick, true);
    document.removeEventListener('submit', handleSubmit, true);
    document.removeEventListener('visibilitychange', handleVisibilityChange, true);
    window.removeEventListener('pagehide', handlePageHide, true);

    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (safetyInterval) {
      clearInterval(safetyInterval);
      safetyInterval = null;
    }
    pendingFieldPayload = null;
    lastDispatchedValues.clear();
    window.__submitlog_autosave_active = false;
  };

  return { success: true };
}

/**
 * Disarms and removes autosave listeners from the current page.
 */
export function injectedDisarmAutosave(): { success: boolean } {
  if (typeof window.__submitlog_autosave_flush === 'function') {
    window.__submitlog_autosave_flush();
  }
  if (typeof window.__submitlog_autosave_cleanup === 'function') {
    window.__submitlog_autosave_cleanup();
  }
  window.__submitlog_autosave_active = false;
  return { success: true };
}

/**
 * Queries whether autosave is active on the current page.
 */
export function injectedGetAutosaveStatus(): InjectedAutosaveStatus {
  return {
    active: Boolean(window.__submitlog_autosave_active),
    editingSessionId: window.__submitlog_autosave_session?.editingSessionId,
  };
}
