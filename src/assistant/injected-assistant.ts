/**
 * Self-contained field-level SubmitLog assistant.
 * Injected into the page context using Shadow DOM isolation.
 * Provides contextual fill, save, and copy next to eligible form fields.
 * Bootstraps from extension-owned persistent AnswerIndex so indicators survive F5.
 * Never attaches to password, OTP, or sensitive fields.
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
    // If already active, trigger a re-scan of the page
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
        transition: transform 0.15s ease, border-color 0.15s ease;
        outline: none;
        user-select: none;
        padding: 0;
      }
      .assistant-trigger:hover, .assistant-trigger:focus-visible {
        transform: scale(1.08);
        border-color: #0066cc;
        box-shadow: 0 0 0 2px rgba(0, 102, 204, 0.25);
      }
      .assistant-trigger.state-saved {
        border-color: #34a853;
        background: #f0fdf4;
      }
      .assistant-trigger.state-changed {
        border-color: #ff9500;
        background: #fffbf0;
      }
      .trigger-icon {
        width: 12px;
        height: 12px;
        color: #555555;
      }
      .state-saved .trigger-icon {
        color: #2e7d32;
      }
      .state-changed .trigger-icon {
        color: #b36b00;
      }
      .assistant-menu {
        display: none;
        position: absolute;
        pointer-events: auto;
        width: 220px;
        background: #ffffff;
        color: #1d1d1f;
        border: 1px solid #d2d2d7;
        border-radius: 8px;
        box-shadow: 0 4px 16px rgba(0,0,0,0.18);
        padding: 8px;
        flex-direction: column;
        gap: 4px;
        font-size: 13px;
      }
      .assistant-menu.open {
        display: flex;
      }
      .menu-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 4px 6px 6px 6px;
        border-bottom: 1px solid rgba(0,0,0,0.08);
        font-weight: 600;
        font-size: 12px;
      }
      .menu-badge {
        font-size: 10px;
        padding: 2px 6px;
        border-radius: 4px;
        font-weight: 500;
      }
      .badge-available {
        background: rgba(52, 168, 83, 0.15);
        color: #2e7d32;
      }
      .badge-none {
        background: rgba(142, 142, 147, 0.15);
        color: #8e8e93;
      }
      .menu-item {
        display: flex;
        align-items: center;
        width: 100%;
        padding: 6px 8px;
        border-radius: 6px;
        border: none;
        background: transparent;
        color: inherit;
        font-size: 12px;
        text-align: left;
        cursor: pointer;
        outline: none;
      }
      .menu-item:hover, .menu-item:focus-visible {
        background: rgba(0, 102, 204, 0.08);
        color: #0066cc;
      }
      .menu-item-primary {
        font-weight: 600;
        color: #0066cc;
      }
      .menu-item-secondary {
        color: #555555;
      }
      .copy-feedback {
        font-size: 10px;
        color: #34a853;
        margin-left: auto;
      }
      @media (prefers-color-scheme: dark) {
        .assistant-trigger {
          background: #2c2c2e;
          border-color: #48484a;
        }
        .trigger-icon {
          color: #d1d1d6;
        }
        .assistant-trigger.state-saved {
          background: #14331e;
          border-color: #34a853;
        }
        .assistant-trigger.state-changed {
          background: #3a2e12;
          border-color: #ff9500;
        }
        .assistant-menu {
          background: #1c1c1e;
          color: #f5f5f7;
          border-color: #3a3a3c;
          box-shadow: 0 4px 16px rgba(0,0,0,0.4);
        }
        .menu-header {
          border-bottom-color: rgba(255,255,255,0.1);
        }
        .menu-item-secondary {
          color: #98989d;
        }
        .menu-item:hover, .menu-item:focus-visible {
          background: rgba(77, 163, 255, 0.15);
          color: #4da3ff;
        }
      }
    </style>
    <div class="assistant-container" id="container">
      <button
        class="assistant-trigger"
        id="trigger"
        type="button"
        aria-label="SubmitLog field assistant"
        aria-haspopup="true"
        aria-expanded="false"
      >
        <svg class="trigger-icon" viewBox="0 0 16 16" fill="currentColor">
          <path d="M12.146.146a.5.5 0 0 1 .708 0l3 3a.5.5 0 0 1 0 .708l-10 10a.5.5 0 0 1-.168.11l-5 2a.5.5 0 0 1-.65-.65l2-5a.5.5 0 0 1 .11-.168l10-10zM11.207 2.5 13.5 4.793 14.793 3.5 12.5 1.207 11.207 2.5zm1.586 3L10.5 3.207 4 9.707V10h.5a.5.5 0 0 1 .5.5v.5h.5a.5.5 0 0 1 .5.5v.5h.293l6.5-6.5zm-9.761 5.175-.106.106-1.528 3.821 3.821-1.528.106-.106A.5.5 0 0 1 5 12.5V12h-.5a.5.5 0 0 1-.5-.5V11h-.5a.5.5 0 0 1-.468-.325z"/>
        </svg>
      </button>
      <div class="assistant-menu" id="menu" role="menu">
        <!-- Dynamically rendered items -->
      </div>
    </div>
  `;

  const container = shadow.getElementById('container') as HTMLElement;
  const trigger = shadow.getElementById('trigger') as HTMLButtonElement;
  const menu = shadow.getElementById('menu') as HTMLElement;

  let currentTargetEl: (HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement) | null = null;
  let currentSavedAnswer = '';
  let hasOtherSaved = false;
  let isMenuOpen = false;

  // Cache of available answers from AnswerIndex
  const availableAnswersByNormLabel = new Map<string, AvailableAnswerInfo>();

  function updatePosition() {
    if (!currentTargetEl || !currentTargetEl.isConnected) {
      container.classList.remove('visible');
      closeMenu();
      return;
    }

    const rect = currentTargetEl.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      container.classList.remove('visible');
      closeMenu();
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

    // Position menu
    const menuTop = triggerTop + 26;
    const menuLeft = Math.max(8, triggerLeft - 190);
    menu.style.left = `${menuLeft}px`;
    menu.style.top = `${menuTop}px`;
  }

  function openMenu() {
    isMenuOpen = true;
    menu.classList.add('open');
    trigger.setAttribute('aria-expanded', 'true');
    renderMenuItems();
    const firstItem = menu.querySelector('button') as HTMLElement | null;
    if (firstItem) {
      firstItem.focus();
    }
  }

  function closeMenu() {
    if (!isMenuOpen) return;
    isMenuOpen = false;
    menu.classList.remove('open');
    trigger.setAttribute('aria-expanded', 'false');
  }

  function renderMenuItems() {
    if (!currentTargetEl) return;
    const val = getFieldValue(currentTargetEl).trim();
    const hasSaved = Boolean(currentSavedAnswer && currentSavedAnswer.trim().length > 0);
    const isDifferent = hasSaved && currentSavedAnswer.trim() !== val;

    let html = `
      <div class="menu-header">
        <span>SubmitLog</span>
        <span class="menu-badge ${hasSaved ? 'badge-available' : 'badge-none'}">
          ${hasSaved ? '✓ Saved answer' : 'No saved answer'}
        </span>
      </div>
    `;

    if (hasSaved) {
      html += `
        <button class="menu-item menu-item-primary" id="btn-fill-field" role="menuitem" type="button">
          Fill saved answer
        </button>
      `;
      if (isDifferent && val) {
        html += `
          <button class="menu-item menu-item-primary" id="btn-update-field" role="menuitem" type="button">
            Update saved answer
          </button>
        `;
      }
      html += `
        <button class="menu-item menu-item-secondary" id="btn-copy-field" role="menuitem" type="button">
          Copy saved answer <span class="copy-feedback" id="copy-status"></span>
        </button>
      `;
    } else {
      if (val) {
        html += `
          <button class="menu-item menu-item-primary" id="btn-save-field" role="menuitem" type="button">
            Save this answer
          </button>
        `;
      }
    }

    if (hasOtherSaved) {
      html += `
        <button class="menu-item menu-item-secondary" id="btn-fill-form" role="menuitem" type="button">
          Fill entire form
        </button>
      `;
    }

    html += `
      <button class="menu-item menu-item-secondary" id="btn-open-archive" role="menuitem" type="button">
        Open Archive
      </button>
    `;

    menu.innerHTML = html;

    // Attach click listeners
    const btnFill = menu.querySelector('#btn-fill-field') as HTMLButtonElement | null;
    btnFill?.addEventListener('click', () => {
      fillThisField();
    });

    const btnUpdate = menu.querySelector('#btn-update-field') as HTMLButtonElement | null;
    btnUpdate?.addEventListener('click', () => {
      saveThisField();
    });

    const btnSave = menu.querySelector('#btn-save-field') as HTMLButtonElement | null;
    btnSave?.addEventListener('click', () => {
      saveThisField();
    });

    const btnCopy = menu.querySelector('#btn-copy-field') as HTMLButtonElement | null;
    btnCopy?.addEventListener('click', () => {
      copySavedAnswer();
    });

    const btnFillForm = menu.querySelector('#btn-fill-form') as HTMLButtonElement | null;
    btnFillForm?.addEventListener('click', () => {
      fillEntireForm();
    });

    const btnArchive = menu.querySelector('#btn-open-archive') as HTMLButtonElement | null;
    btnArchive?.addEventListener('click', () => {
      openArchive();
    });
  }

  function fillThisField() {
    if (!currentTargetEl || !currentSavedAnswer) return;
    window.__submitlog_suppress_autosave = true;

    if (currentTargetEl instanceof HTMLInputElement && currentTargetEl.type === 'checkbox') {
      const shouldCheck = currentSavedAnswer.toLowerCase() === 'checked';
      currentTargetEl.checked = shouldCheck;
      currentTargetEl.dispatchEvent(new Event('input', { bubbles: true }));
      currentTargetEl.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (currentTargetEl instanceof HTMLSelectElement) {
      const targetVal = currentSavedAnswer.trim().toLowerCase();
      for (let i = 0; i < currentTargetEl.options.length; i++) {
        const opt = currentTargetEl.options[i];
        if (opt) {
          const t = opt.text.trim().toLowerCase();
          const v = opt.value.trim().toLowerCase();
          if (t === targetVal || v === targetVal) {
            currentTargetEl.selectedIndex = i;
            break;
          }
        }
      }
      currentTargetEl.dispatchEvent(new Event('input', { bubbles: true }));
      currentTargetEl.dispatchEvent(new Event('change', { bubbles: true }));
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
      currentTargetEl.dispatchEvent(new Event('input', { bubbles: true }));
      currentTargetEl.dispatchEvent(new Event('change', { bubbles: true }));
    }

    updateTriggerVisualState();
    closeMenu();
    currentTargetEl.focus();

    setTimeout(() => {
      window.__submitlog_suppress_autosave = false;
    }, 500);
  }

  function saveThisField() {
    if (!currentTargetEl) return;
    const label = extractLabel(currentTargetEl);
    const value = getFieldValue(currentTargetEl);
    const fieldType =
      currentTargetEl instanceof HTMLTextAreaElement
        ? 'textarea'
        : currentTargetEl instanceof HTMLSelectElement
          ? 'select'
          : (currentTargetEl as HTMLInputElement).type || 'text';

    if (!value || value.trim() === '') {
      closeMenu();
      return;
    }

    sendMessageToBackground(
      {
        type: 'SUBMITLOG_SAVE_FIELD',
        payload: {
          hostname: window.location.hostname,
          pageTitle: document.title,
          pageUrl: window.location.href,
          field: { label, fieldType, value: value.trim() },
        },
      },
      () => {
        currentSavedAnswer = value.trim();
        const norm = normalize(label);
        availableAnswersByNormLabel.set(norm, { value: value.trim(), fieldType, count: 1 });
        updateTriggerVisualState();
        closeMenu();
        currentTargetEl?.focus();
      },
    );
  }

  function copySavedAnswer() {
    if (!currentSavedAnswer) return;
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        navigator.clipboard.writeText(currentSavedAnswer);
      }
    } catch {
      // ignore
    }
    const status = menu.querySelector('#copy-status');
    if (status) {
      status.textContent = '✓ Copied';
      setTimeout(() => {
        if (status) status.textContent = '';
      }, 1500);
    }
  }

  function fillEntireForm() {
    sendMessageToBackground(
      {
        type: 'SUBMITLOG_TRIGGER_FILL_ALL',
        payload: { hostname: window.location.hostname },
      },
      () => {
        closeMenu();
      },
    );
  }

  function openArchive() {
    sendMessageToBackground({
      type: 'SUBMITLOG_OPEN_ARCHIVE',
    });
    closeMenu();
  }

  function updateTriggerVisualState() {
    if (!currentTargetEl) return;
    const currentVal = getFieldValue(currentTargetEl).trim();
    trigger.classList.remove('state-saved', 'state-changed');

    if (currentSavedAnswer && currentSavedAnswer.trim().length > 0) {
      if (currentSavedAnswer.trim() === currentVal) {
        trigger.classList.add('state-saved');
      } else {
        trigger.classList.add('state-changed');
      }
    }
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
    if (cached) {
      currentSavedAnswer = cached.value;
      hasOtherSaved = availableAnswersByNormLabel.size > 1;
      updateTriggerVisualState();
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
          currentSavedAnswer = resp.savedAnswer || '';
          hasOtherSaved = Boolean(resp.hasOtherSavedAnswers);
          if (currentSavedAnswer) {
            availableAnswersByNormLabel.set(norm, {
              value: currentSavedAnswer,
              fieldType,
              count: resp.totalSavedAnswers || 1,
            });
          }
          updateTriggerVisualState();
        }
      },
    );
  }

  function sendMessageToBackground(msg: unknown, cb?: (res: unknown) => void) {
    try {
      const g = globalThis as unknown as {
        browser?: { runtime?: { sendMessage?: (m: unknown, c?: (r: unknown) => void) => void } };
        chrome?: { runtime?: { sendMessage?: (m: unknown, c?: (r: unknown) => void) => void } };
      };
      const runtime = g.browser?.runtime || g.chrome?.runtime || null;
      if (runtime && typeof runtime.sendMessage === 'function') {
        runtime.sendMessage(msg, cb);
      }
    } catch {
      // ignore
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
              availableAnswersByNormLabel.set(normalize(k), v);
            }
            // If we currently have an active element, update its state
            if (currentTargetEl) {
              const label = extractLabel(currentTargetEl);
              const matched = availableAnswersByNormLabel.get(normalize(label));
              if (matched) {
                currentSavedAnswer = matched.value;
                updateTriggerVisualState();
              }
            } else {
              // On initial page load/reload: inspect eligible fields and attach to the first eligible field with answers if any
              attachToEligibleFieldWithAnswer();
            }
          }
        }
      },
    );
  }

  // Inspects fields and attaches assistant indicator to fields with saved answers
  function attachToEligibleFieldWithAnswer() {
    if (currentTargetEl) return;
    const allInputs = document.querySelectorAll<
      HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
    >('input, textarea, select');
    for (const el of allInputs) {
      if (!isEligibleField(el)) continue;
      const label = extractLabel(el);
      const norm = normalize(label);
      if (availableAnswersByNormLabel.has(norm)) {
        currentTargetEl = el;
        const answer = availableAnswersByNormLabel.get(norm);
        currentSavedAnswer = answer?.value || '';
        hasOtherSaved = availableAnswersByNormLabel.size > 1;
        updatePosition();
        updateTriggerVisualState();
        break;
      }
    }
  }

  // Event handlers
  function handleFocusIn(e: FocusEvent) {
    const target = e.target as HTMLElement | null;
    if (isEligibleField(target)) {
      currentTargetEl = target;
      updatePosition();
      queryFieldStatus(target);
    } else {
      if (!shadow?.contains(target)) {
        currentTargetEl = null;
        container.classList.remove('visible');
        closeMenu();
      }
    }
  }

  function handleInput(e: Event) {
    const target = e.target as HTMLElement | null;
    if (target === currentTargetEl) {
      updateTriggerVisualState();
      updatePosition();
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && isMenuOpen) {
      e.stopPropagation();
      closeMenu();
      currentTargetEl?.focus();
    }
  }

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    if (isMenuOpen) {
      closeMenu();
    } else {
      openMenu();
    }
  });

  document.addEventListener('focusin', handleFocusIn, true);
  document.addEventListener('input', handleInput, true);
  document.addEventListener('change', handleInput, true);
  window.addEventListener('scroll', updatePosition, true);
  window.addEventListener('resize', updatePosition);
  document.addEventListener('keydown', handleKeydown, true);

  // Global click to close menu
  const handleGlobalClick = (e: MouseEvent) => {
    if (isMenuOpen && !shadow?.contains(e.target as Node)) {
      closeMenu();
    }
  };
  document.addEventListener('click', handleGlobalClick, true);

  // MutationObserver to detect newly inserted form fields (SPA workflows)
  let observerTimer: ReturnType<typeof setTimeout> | null = null;
  const observer = new MutationObserver(() => {
    if (observerTimer) clearTimeout(observerTimer);
    observerTimer = setTimeout(() => {
      if (!currentTargetEl) {
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

  // Initial bootstrap from AnswerIndex
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
    document.removeEventListener('keydown', handleKeydown, true);
    document.removeEventListener('click', handleGlobalClick, true);
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
