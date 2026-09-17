/**
 * Event-delegated autosave injected into the page context.
 */

import { isElementSensitive } from '../security/sensitive-patterns';

export interface ArmAutosaveOptions {
  editingSessionId: string;
  formFingerprint?: string;
  formFamilyKey?: string;
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
    __submitlog_autosave_on_delete?: () => void;
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
  window.__submitlog_suppress_autosave = false;

  function isSensitive(el: HTMLElement, extractedLabel?: string): boolean {
    if (el instanceof HTMLInputElement && el.type === 'file') return true;
    return isElementSensitive(el, extractedLabel).isSensitive;
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

  interface PendingFieldState {
    label: string;
    value: string;
    fieldType: string;
    dirty: boolean;
    lastDispatchedValue: string;
    timer: ReturnType<typeof setTimeout> | null;
    clientTimestamp: number;
    revision: number;
  }

  const pendingFields = new Map<string, PendingFieldState>();
  let safetyInterval: ReturnType<typeof setInterval> | null = null;

  function getFieldKey(label: string, fieldType: string): string {
    return `${label.toLowerCase().trim()}::${fieldType.toLowerCase().trim()}`;
  }

  function flushField(key: string) {
    const fieldState = pendingFields.get(key);
    if (!fieldState) return;

    if (fieldState.timer) {
      clearTimeout(fieldState.timer);
      fieldState.timer = null;
    }

    if (!fieldState.dirty && fieldState.lastDispatchedValue === fieldState.value) {
      return;
    }

    const payloadToSend = {
      label: fieldState.label,
      value: fieldState.value,
      fieldType: fieldState.fieldType,
    };
    const clientTimestamp = fieldState.clientTimestamp;
    const revision = fieldState.revision;

    fieldState.lastDispatchedValue = fieldState.value;
    fieldState.dirty = false;

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
        const pageOrigin = (() => {
          try {
            return new URL(options.pageUrl).origin;
          } catch {
            return window.location.origin && window.location.origin !== 'null'
              ? window.location.origin
              : `https://${options.hostname}`;
          }
        })();
        const origin = options.origin || pageOrigin;
        const pathname = options.pathname || window.location.pathname || '/';

        const promise: unknown = runtime.sendMessage(
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
              formFamilyKey: options.formFamilyKey,
              matchingSubmissionId: options.matchingSubmissionId,
              clientTimestamp,
              revision,
              field: payloadToSend,
              allCurrentFields: options.initialFields,
            },
          },
          (res: unknown) => {
            try {
              const _err = (runtime as unknown as { lastError?: unknown }).lastError;
            } catch {
              // ignore
            }
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
        if (promise && typeof (promise as { catch?: unknown }).catch === 'function') {
          (promise as Promise<unknown>).catch(() => {});
        }
      }
    } catch {
      // Ignore background communication failures
    }
  }

  let isDraftDeleted = false;

  window.__submitlog_autosave_on_delete = () => {
    isDraftDeleted = true;
    for (const state of pendingFields.values()) {
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
      }
    }
    pendingFields.clear();
  };

  function flushAllFields() {
    if (isDraftDeleted || pendingFields.size === 0) return;
    for (const key of Array.from(pendingFields.keys())) {
      flushField(key);
    }
  }

  window.__submitlog_autosave_flush = flushAllFields;

  function processElementChange(
    target: HTMLElement,
    delayMs = 300,
    immediate = false,
    isUserEdit = false,
  ) {
    if (window.__submitlog_suppress_autosave) return;

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
    if (isSensitive(target, label)) return;

    // A real user edit occurred, allow drafting again
    if (isUserEdit) {
      isDraftDeleted = false;
    } else if (isDraftDeleted) {
      // Focusout, blur, or non-edit interaction after deletion MUST NEVER recreate draft
      return;
    }

    const key = getFieldKey(label, fieldType);
    let state = pendingFields.get(key);

    if (!state) {
      state = {
        label: label.trim(),
        value: value.trim(),
        fieldType,
        dirty: false,
        lastDispatchedValue: '',
        timer: null,
        clientTimestamp: Date.now(),
        revision: 0,
      };
      pendingFields.set(key, state);
    }

    state.value = value.trim();
    state.dirty = true;
    if (isUserEdit) {
      state.clientTimestamp = Date.now();
      state.revision++;
    }

    if (immediate || delayMs <= 0) {
      flushField(key);
    } else {
      if (state.timer) {
        clearTimeout(state.timer);
      }
      state.timer = setTimeout(() => {
        flushField(key);
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
      // Debounced write per field: 300ms after keystroke
      processElementChange(target, 300, false, true);
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
      // Immediate finalization on blur/focusout only if dirty: no debounce delay
      processElementChange(target, 0, true, false);
    }
  };

  const handleChange = (e: Event) => {
    const target = e.target as HTMLElement | null;
    if (target && (target instanceof HTMLSelectElement || target instanceof HTMLInputElement)) {
      // Immediate flush on change
      processElementChange(target, 0, true, true);
    }
  };

  const handleClick = (e: MouseEvent) => {
    const target = e.target as HTMLElement | null;
    const radioOrCheckbox = target?.closest<HTMLElement>('[role="radio"], [role="checkbox"]');
    if (radioOrCheckbox) {
      setTimeout(() => processElementChange(radioOrCheckbox, 0, true, true), 0);
    }
  };

  const handleSubmit = () => {
    flushAllFields();
  };

  const handleVisibilityChange = () => {
    if (document.visibilityState === 'hidden') {
      flushAllFields();
    }
  };

  const handlePageHide = () => {
    flushAllFields();
  };

  // Periodic safety flush every 2.5s when dirty
  safetyInterval = setInterval(() => {
    flushAllFields();
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

    for (const state of pendingFields.values()) {
      if (state.timer) {
        clearTimeout(state.timer);
      }
    }
    pendingFields.clear();

    if (safetyInterval) {
      clearInterval(safetyInterval);
      safetyInterval = null;
    }
    window.__submitlog_autosave_active = false;
  };

  return { success: true };
}

/**
 * Disarms and removes autosave listeners from the current page.
 * @param shouldFlush If true, flushes any pending edits before disarming. If false (e.g. on pause), drops pending edits.
 */
export function injectedDisarmAutosave(shouldFlush = true): { success: boolean } {
  if (shouldFlush && typeof window.__submitlog_autosave_flush === 'function') {
    window.__submitlog_autosave_flush();
  }
  if (typeof window.__submitlog_autosave_cleanup === 'function') {
    window.__submitlog_autosave_cleanup();
  }
  window.__submitlog_autosave_active = false;
  window.__submitlog_suppress_autosave = false;
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
