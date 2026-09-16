/**
 * Self-contained field-level SubmitLog assistant.
 * Injected into the page context using Shadow DOM isolation.
 * Provides a single-click contextual pencil control next to eligible form fields
 * that have a saved answer in SubmitLog's Answer Memory.
 *
 * Requirements:
 * 1. The pencil icon ONLY appears when a saved answer exists for that field/question.
 * 2. Clicking the pencil ONCE immediately fills the latest saved answer.
 * 3. No assistant menu is opened first.
 * 4. Dispatches framework-compatible input and change events.
 * 5. Briefly provides subtle visual success feedback (e.g. checkmark).
 * 6. Never attaches to password, OTP, or sensitive fields.
 */

export interface AssistantFieldStatus {
  matchingSubmissionId?: string;
  savedAnswer?: string;
  hasOtherSavedAnswers: boolean;
  totalSavedAnswers: number;
}

export interface AvailableAnswerInfo {
  value: string;
  fieldType: string;
  count: number;
}

export function initFieldAssistant(): { success: boolean } {
  if (typeof window === 'undefined' || !document || !document.body) {
    return { success: false };
  }

  // Prevent multiple initializations
  if (window.__submitlog_assistant_active) {
    if (typeof window.__submitlog_assistant_rescan === 'function') {
      window.__submitlog_assistant_rescan();
    }
    return { success: true };
  }

  window.__submitlog_assistant_active = true;

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
      const type = (el.type || '').toLowerCase();
      if (type === 'password' || type === 'hidden' || type === 'file') return true;
      const ac = (el.autocomplete || '').toLowerCase();
      if (SENSITIVE_AUTOCOMPLETE.some((s) => ac.includes(s))) return true;
    }
    const name = el.getAttribute('name') || '';
    const id = el.id || '';
    const ariaLabel = el.getAttribute('aria-label') || '';
    const cleanLabel = (name + ' ' + id + ' ' + ariaLabel).replace(/[\s\-_]+/g, '');
    if (
      SENSITIVE_PATTERN.test(name) ||
      SENSITIVE_PATTERN.test(id) ||
      SENSITIVE_PATTERN.test(ariaLabel) ||
      SENSITIVE_PATTERN.test(cleanLabel)
    ) {
      return true;
    }
    return false;
  }

  function isEligibleField(
    el: HTMLElement | null,
  ): el is HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
    if (!el) return false;
    const isInput = el instanceof HTMLInputElement;
    const isTextArea = el instanceof HTMLTextAreaElement;
    const isSelect = el instanceof HTMLSelectElement;
    if (!isInput && !isTextArea && !isSelect) return false;

    if (isInput) {
      const type = (el.type || '').toLowerCase();
      if (type === 'file' || type === 'password' || type === 'hidden') return false;
      if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image')
        return false;
    }

    if (isSensitive(el)) return false;
    return true;
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
    const placeholder = el.getAttribute('placeholder');
    if (placeholder && placeholder.trim()) return placeholder.trim();
    const name = el.getAttribute('name');
    if (name && name.trim()) return name.trim();
    return el.id || 'Field';
  }

  function getFieldValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): string {
    if (el instanceof HTMLInputElement && el.type === 'checkbox') {
      return el.checked ? 'Checked' : 'Not checked';
    }
    if (el instanceof HTMLInputElement && el.type === 'radio') {
      return el.checked ? el.value || 'Selected' : '';
    }
    if (el instanceof HTMLSelectElement) {
      const opt = el.options[el.selectedIndex];
      return opt ? opt.text.trim() || opt.value.trim() : el.value;
    }
    return el.value || '';
  }

  // Create isolated Shadow DOM root
  let rootEl = document.getElementById('submitlog-assistant-root');
  if (!rootEl) {
    rootEl = document.createElement('div');
    rootEl.id = 'submitlog-assistant-root';
    (document.documentElement || document.body).appendChild(rootEl);
  }

  let shadow = rootEl.shadowRoot;
  if (!shadow) {
    shadow = rootEl.attachShadow({ mode: 'open' });
  }

  shadow.innerHTML = `
    <style>
      :host {
        all: initial;
        position: absolute;
        top: 0;
        left: 0;
        z-index: 2147483640;
        pointer-events: none;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      }
      * {
        box-sizing: border-box;
      }
      .assistant-container {
        display: none;
      }
      .assistant-container.visible {
        display: block;
      }
      .assistant-trigger {
        position: absolute;
        pointer-events: auto;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 22px;
        height: 22px;
        border-radius: 50%;
        background: #ffffff;
        border: 1px solid #d2d2d7;
        box-shadow: 0 1px 3px rgba(0,0,0,0.14);
        cursor: pointer;
        transition: transform 0.15s ease, border-color 0.15s ease, background 0.15s ease;
        outline: none;
        user-select: none;
        padding: 0;
      }
      .assistant-trigger:hover, .assistant-trigger:focus-visible {
        transform: scale(1.1);
        border-color: #0066cc;
        box-shadow: 0 0 0 2px rgba(0, 102, 204, 0.25);
      }
      .assistant-trigger.state-saved {
        border-color: #34a853;
        background: #f0fdf4;
      }
      .trigger-icon {
        width: 12px;
        height: 12px;
        color: #0066cc;
      }
      .icon-success {
        color: #2e7d32;
      }
      @media (prefers-color-scheme: dark) {
        .assistant-trigger {
          background: #2c2c2e;
          border-color: #48484a;
        }
        .trigger-icon {
          color: #4da3ff;
        }
        .assistant-trigger.state-saved {
          background: #14331e;
          border-color: #34a853;
        }
        .icon-success {
          color: #4caf50;
        }
      }
    </style>
    <div class="assistant-container" id="container">
      <button
        class="assistant-trigger"
        id="trigger"
        type="button"
        aria-label="Fill saved answer with SubmitLog"
        title="Fill saved answer"
      >
        <svg class="trigger-icon icon-pencil" viewBox="0 0 16 16" fill="currentColor">
          <path d="M12.146.146a.5.5 0 0 1 .708 0l3 3a.5.5 0 0 1 0 .708l-10 10a.5.5 0 0 1-.168.11l-5 2a.5.5 0 0 1-.65-.65l2-5a.5.5 0 0 1 .11-.168l10-10zM11.207 2.5 13.5 4.793 14.793 3.5 12.5 1.207 11.207 2.5zm1.586 3L10.5 3.207 4 9.707V10h.5a.5.5 0 0 1 .5.5v.5h.5a.5.5 0 0 1 .5.5v.5h.293l6.5-6.5zm-9.761 5.175-.106.106-1.528 3.821 3.821-1.528.106-.106A.5.5 0 0 1 5 12.5V12h-.5a.5.5 0 0 1-.5-.5V11h-.5a.5.5 0 0 1-.468-.325z"/>
        </svg>
        <svg class="trigger-icon icon-success" viewBox="0 0 16 16" fill="currentColor" style="display:none;">
          <path d="M13.854 3.646a.5.5 0 0 1 0 .708l-7 7a.5.5 0 0 1-.708 0l-3.5-3.5a.5.5 0 1 1 .708-.708L6.5 10.293l6.646-6.647a.5.5 0 0 1 .708 0z"/>
        </svg>
      </button>
    </div>
  `;

  const container = shadow.getElementById('container') as HTMLElement;
  const trigger = shadow.getElementById('trigger') as HTMLButtonElement;

  let currentTargetEl: (HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement) | null = null;
  let currentSavedAnswer = '';

  // Cache of available answers from Answer Memory / AnswerIndex
  const availableAnswersByNormLabel = new Map<string, AvailableAnswerInfo>();

  function updatePosition() {
    if (!currentTargetEl || !currentTargetEl.isConnected) {
      container.classList.remove('visible');
      return;
    }

    // Only show pencil if a saved answer exists
    if (!currentSavedAnswer || !currentSavedAnswer.trim()) {
      container.classList.remove('visible');
      return;
    }

    const rect = currentTargetEl.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      container.classList.remove('visible');
      return;
    }

    container.classList.add('visible');

    const scrollX = window.scrollX || window.pageXOffset;
    const scrollY = window.scrollY || window.pageYOffset;

    let triggerLeft = scrollX + rect.right - 26;
    if (rect.width < 100) {
      triggerLeft = scrollX + rect.right + 4;
    }
    const triggerTop = scrollY + rect.top + Math.max(0, (rect.height - 22) / 2);

    trigger.style.left = `${triggerLeft}px`;
    trigger.style.top = `${triggerTop}px`;
  }

  /**
   * One-click fill: immediately sets value, dispatches events, and provides brief visual feedback.
   */
  function fillThisField() {
    if (!currentTargetEl || !currentSavedAnswer) return;
    window.__submitlog_suppress_autosave = true;

    if (currentTargetEl instanceof HTMLInputElement && currentTargetEl.type === 'checkbox') {
      const lower = currentSavedAnswer.toLowerCase().trim();
      const shouldCheck = lower === 'checked' || lower === 'true' || lower === 'yes';
      const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked');
      if (desc && desc.set) {
        desc.set.call(currentTargetEl, shouldCheck);
      } else {
        currentTargetEl.checked = shouldCheck;
      }
      currentTargetEl.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
      currentTargetEl.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    } else if (currentTargetEl instanceof HTMLInputElement && currentTargetEl.type === 'radio') {
      const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked');
      if (desc && desc.set) {
        desc.set.call(currentTargetEl, true);
      } else {
        currentTargetEl.checked = true;
      }
      currentTargetEl.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }));
      currentTargetEl.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    } else if (currentTargetEl instanceof HTMLSelectElement) {
      const targetVal = currentSavedAnswer.trim().toLowerCase();
      let found = false;
      for (let i = 0; i < currentTargetEl.options.length; i++) {
        const opt = currentTargetEl.options[i];
        if (opt) {
          const t = opt.text.trim().toLowerCase();
          const v = opt.value.trim().toLowerCase();
          if (t === targetVal || v === targetVal) {
            currentTargetEl.selectedIndex = i;
            found = true;
            break;
          }
        }
      }
      if (!found) {
        currentTargetEl.value = currentSavedAnswer;
      }
      currentTargetEl.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
      currentTargetEl.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    } else {
      const proto =
        currentTargetEl instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (typeof setter === 'function') {
        setter.call(currentTargetEl, currentSavedAnswer);
      } else {
        currentTargetEl.value = currentSavedAnswer;
      }
      currentTargetEl.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
      currentTargetEl.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    }

    // Subtle visual feedback: temporarily display success checkmark
    const iconPencil = shadow?.querySelector('.icon-pencil') as HTMLElement | null;
    const iconSuccess = shadow?.querySelector('.icon-success') as HTMLElement | null;
    if (iconPencil && iconSuccess) {
      iconPencil.style.display = 'none';
      iconSuccess.style.display = 'block';
      trigger.classList.add('state-saved');
      setTimeout(() => {
        iconPencil.style.display = 'block';
        iconSuccess.style.display = 'none';
      }, 800);
    }

    currentTargetEl.focus();

    setTimeout(() => {
      window.__submitlog_suppress_autosave = false;
    }, 500);
  }

  function queryFieldStatus(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement) {
    const label = extractLabel(el);
    const fieldType =
      el instanceof HTMLTextAreaElement
        ? 'textarea'
        : el instanceof HTMLSelectElement
          ? 'select'
          : (el as HTMLInputElement).type || 'text';
    const value = getFieldValue(el);

    // Fast path: check in-memory bootstrapped answers
    const norm = normalize(label);
    const cached = availableAnswersByNormLabel.get(norm);
    if (cached && cached.value.trim()) {
      currentSavedAnswer = cached.value;
      updatePosition();
    } else {
      currentSavedAnswer = '';
      container.classList.remove('visible');
    }

    sendMessageToBackground(
      {
        type: 'SUBMITLOG_GET_FIELD_STATUS',
        payload: {
          hostname: window.location.hostname,
          field: { label, fieldType, value },
        },
      },
      (res: unknown) => {
        if (res && typeof res === 'object') {
          const resp = res as AssistantFieldStatus & { privateBrowsing?: boolean };
          if (resp.privateBrowsing) {
            disarmFieldAssistant();
            return;
          }
          const answer = resp.savedAnswer?.trim() || '';
          if (answer) {
            currentSavedAnswer = answer;
            availableAnswersByNormLabel.set(norm, {
              value: answer,
              fieldType,
              count: resp.totalSavedAnswers || 1,
            });
            updatePosition();
          } else if (!cached) {
            currentSavedAnswer = '';
            container.classList.remove('visible');
          }
        }
      },
    );
  }

  function sendMessageToBackground(msg: unknown, cb?: (res: unknown) => void) {
    try {
      const g = globalThis as unknown as {
        browser?: { runtime?: { sendMessage?: (m: unknown, c?: (r: unknown) => void) => unknown } };
        chrome?: { runtime?: { sendMessage?: (m: unknown, c?: (r: unknown) => void) => unknown } };
      };
      const w = (typeof window !== 'undefined' ? window : {}) as unknown as {
        browser?: { runtime?: { sendMessage?: (m: unknown, c?: (r: unknown) => void) => unknown } };
        chrome?: { runtime?: { sendMessage?: (m: unknown, c?: (r: unknown) => void) => unknown } };
      };
      const runtime =
        g.browser?.runtime || g.chrome?.runtime || w.browser?.runtime || w.chrome?.runtime || null;
      if (runtime && typeof runtime.sendMessage === 'function') {
        let callbackCalled = false;
        const safeCb = (res: unknown) => {
          if (callbackCalled) return;
          callbackCalled = true;
          if (cb) cb(res);
        };
        const ret = runtime.sendMessage(msg, (res: unknown) => {
          try {
            const _ = (runtime as unknown as { lastError?: unknown }).lastError;
          } catch {
            // ignore
          }
          safeCb(res);
        });
        if (ret && typeof (ret as Promise<unknown>).then === 'function') {
          (ret as Promise<unknown>)
            .then((res) => {
              safeCb(res);
            })
            .catch(() => {});
        }
      }
    } catch {
      // Context invalidated
    }
  }

  // Bootstrap from AnswerIndex: retrieve available answers for this hostname
  function bootstrapFromAnswerIndex() {
    sendMessageToBackground(
      {
        type: 'SUBMITLOG_BOOTSTRAP_ASSISTANT',
        payload: { hostname: window.location.hostname },
      },
      (res: unknown) => {
        if (res && typeof res === 'object') {
          const data = res as {
            availableAnswers?: Record<string, AvailableAnswerInfo>;
            privateBrowsing?: boolean;
          };
          if (data.privateBrowsing) {
            disarmFieldAssistant();
            return;
          }
          if (data.availableAnswers) {
            for (const [k, v] of Object.entries(data.availableAnswers)) {
              if (v && v.value && v.value.trim()) {
                availableAnswersByNormLabel.set(normalize(k), v);
              }
            }
            // If we currently have an active element, check if it now has an answer
            if (currentTargetEl) {
              const label = extractLabel(currentTargetEl);
              const matched = availableAnswersByNormLabel.get(normalize(label));
              if (matched && matched.value.trim()) {
                currentSavedAnswer = matched.value;
                updatePosition();
              } else {
                container.classList.remove('visible');
              }
            } else {
              attachToEligibleFieldWithAnswer();
            }
          }
        }
      },
    );
  }

  // Inspects fields and attaches pencil indicator to eligible field with saved answer
  function attachToEligibleFieldWithAnswer() {
    const allInputs = document.querySelectorAll<
      HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
    >('input, textarea, select');
    for (const el of allInputs) {
      if (!isEligibleField(el)) continue;
      const label = extractLabel(el);
      const norm = normalize(label);
      const answer = availableAnswersByNormLabel.get(norm);
      if (answer && answer.value.trim()) {
        currentTargetEl = el;
        currentSavedAnswer = answer.value;
        updatePosition();
        return;
      }
    }
    // If no eligible field has an answer, hide
    if (!currentTargetEl) {
      container.classList.remove('visible');
    }
  }

  // Event handlers
  function handleFocusIn(e: FocusEvent) {
    const target = e.target as HTMLElement | null;
    if (isEligibleField(target)) {
      currentTargetEl = target;
      queryFieldStatus(target);
    } else {
      const isWithinAssistant =
        target === trigger ||
        (container && container.contains(target)) ||
        (rootEl && rootEl.contains(target)) ||
        (shadow && typeof shadow.contains === 'function' && shadow.contains(target));
      if (!isWithinAssistant) {
        currentTargetEl = null;
        currentSavedAnswer = '';
        container.classList.remove('visible');
      }
    }
  }

  function handleInput(e: Event) {
    const target = e.target as HTMLElement | null;
    if (target === currentTargetEl) {
      updatePosition();
    }
  }

  // Single left click immediately fills the field without opening a menu
  trigger.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    fillThisField();
  });

  document.addEventListener('focusin', handleFocusIn, true);
  document.addEventListener('input', handleInput, true);
  document.addEventListener('change', handleInput, true);
  window.addEventListener('scroll', updatePosition, true);
  window.addEventListener('resize', updatePosition);

  // MutationObserver to detect newly inserted form fields (SPA workflows)
  let observerTimer: ReturnType<typeof setTimeout> | null = null;
  const observer = new MutationObserver(() => {
    if (observerTimer) clearTimeout(observerTimer);
    observerTimer = setTimeout(() => {
      if (!currentTargetEl || !currentTargetEl.isConnected) {
        attachToEligibleFieldWithAnswer();
      } else {
        updatePosition();
      }
    }, 150);
  });

  observer.observe(document.body, { childList: true, subtree: true });

  // SPA navigation listener (popstate)
  const handlePopState = () => {
    setTimeout(() => {
      bootstrapFromAnswerIndex();
    }, 100);
  };
  window.addEventListener('popstate', handlePopState);

  // Initial bootstrap from Answer Memory / AnswerIndex
  bootstrapFromAnswerIndex();

  window.__submitlog_assistant_rescan = () => {
    bootstrapFromAnswerIndex();
  };

  window.__submitlog_assistant_cleanup = () => {
    observer.disconnect();
    if (observerTimer) clearTimeout(observerTimer);
    window.removeEventListener('popstate', handlePopState);
    document.removeEventListener('focusin', handleFocusIn, true);
    document.removeEventListener('input', handleInput, true);
    document.removeEventListener('change', handleInput, true);
    window.removeEventListener('scroll', updatePosition, true);
    window.removeEventListener('resize', updatePosition);
    rootEl?.remove();
    window.__submitlog_assistant_active = false;
    window.__submitlog_assistant_rescan = undefined;
  };

  return { success: true };
}

export function disarmFieldAssistant(): { success: boolean } {
  if (typeof window !== 'undefined' && typeof window.__submitlog_assistant_cleanup === 'function') {
    window.__submitlog_assistant_cleanup();
  }
  return { success: true };
}

declare global {
  interface Window {
    __submitlog_assistant_active?: boolean;
    __submitlog_assistant_cleanup?: () => void;
    __submitlog_assistant_rescan?: () => void;
  }
}
