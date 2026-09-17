/**
 * Self-contained functions for injection via browser.scripting.executeScript.
 * These functions CANNOT import external modules - all logic must be completely self-contained.
 * They run in the web page's content script context across top frame and accessible child frames.
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

export interface InjectedDetectedField {
  label: string;
  fieldType: string;
  excluded?: boolean;
}

export interface InjectedScanResult {
  formDetected: boolean;
  totalFields: number;
  answeredCount: number;
  score: number;
  formFamilyKey?: string;
  inaccessibleFrameDetected?: boolean;
  detectedFields?: InjectedDetectedField[];
}

export interface InjectedCaptureResult {
  formDetected: boolean;
  fields: InjectedCapturedField[];
  excludedCount: number;
  totalDetected: number;
  includedCount: number;
  answeredCount: number;
  formFamilyKey?: string;
  inaccessibleFrameDetected?: boolean;
  detectedFields?: InjectedDetectedField[];
}

/**
 * Scans the current frame/document for candidate forms and scores them structurally.
 * Detects real application forms even when all fields are completely blank.
 */
export function scanPageForms(): InjectedScanResult {
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

  const SEARCH_PATTERNS = /search|lookup|find|query|filter|nav|toolbar/i;
  const APPLICATION_PATTERNS =
    /app|apply|grant|register|signup|contact|proposal|inquiry|feedback|survey|checkout|order|portal|form|intake|submission/i;
  const SUBMIT_BUTTON_PATTERNS =
    /submit|apply|send|save.?draft|save|register|complete|finish|continue|next|review|proceed|confirm/i;

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

  function collectControls(root: ParentNode): HTMLElement[] {
    const controls: HTMLElement[] = [];
    function walk(node: Node) {
      if (node instanceof HTMLElement) {
        const tag = node.tagName.toLowerCase();
        let isControl = false;
        if (tag === 'input' || tag === 'textarea' || tag === 'select') {
          const type = tag === 'input' ? (node as HTMLInputElement).type.toLowerCase() : '';
          if (
            type !== 'hidden' &&
            type !== 'submit' &&
            type !== 'button' &&
            type !== 'image' &&
            type !== 'reset' &&
            type !== 'file'
          ) {
            isControl = true;
          }
        } else {
          const role = node.getAttribute('role')?.toLowerCase();
          if (
            role === 'radio' ||
            role === 'checkbox' ||
            role === 'textbox' ||
            role === 'combobox' ||
            role === 'listbox' ||
            (node.isContentEditable && !node.parentElement?.isContentEditable)
          ) {
            isControl = true;
          }
        }
        if (isControl && isVisible(node)) {
          controls.push(node);
          const role = node.getAttribute('role')?.toLowerCase();
          if (
            tag === 'input' ||
            tag === 'textarea' ||
            tag === 'select' ||
            role === 'radio' ||
            role === 'checkbox'
          ) {
            if (node.shadowRoot) walk(node.shadowRoot);
            return;
          }
        }
        if (node.shadowRoot) walk(node.shadowRoot);
      }
      const children = (node as Element).children || node.childNodes;
      if (children) {
        for (let i = 0; i < children.length; i++) {
          const child = children[i];
          if (child) walk(child);
        }
      }
    }
    walk(root);
    return controls;
  }

  function isUtility(container: Element): boolean {
    const role = container.getAttribute('role')?.toLowerCase();
    if (role === 'search' || role === 'navigation' || role === 'toolbar' || role === 'menubar') {
      return true;
    }
    if (container.closest('nav, [role="navigation"], [role="toolbar"], [role="search"]')) {
      return true;
    }

    const inputs = Array.from(container.querySelectorAll('input'));
    const textareas = container.querySelectorAll('textarea');
    const idAndClass = `${container.id} ${container.className}`.toLowerCase();

    if (
      SEARCH_PATTERNS.test(idAndClass) &&
      !APPLICATION_PATTERNS.test(idAndClass) &&
      textareas.length === 0
    ) {
      if (inputs.length <= 4) return true;
    }

    const hasSearchOrFilterInput = inputs.some(
      (inp) =>
        inp.type === 'search' ||
        inp.name === 'q' ||
        inp.name === 'query' ||
        inp.name === 'search' ||
        inp.name.includes('filter') ||
        inp.id.includes('filter') ||
        inp.getAttribute('aria-label')?.toLowerCase().includes('search'),
    );
    if (hasSearchOrFilterInput && inputs.length <= 3 && textareas.length === 0) {
      return true;
    }

    if (container instanceof HTMLFormElement) {
      const combined = `${container.getAttribute('action') || ''} ${container.getAttribute('name') || ''} ${idAndClass}`;
      if (
        SEARCH_PATTERNS.test(combined) &&
        !APPLICATION_PATTERNS.test(combined) &&
        textareas.length === 0
      ) {
        if (inputs.length <= 4) return true;
      }
    }
    return false;
  }

  function isSensitive(el: HTMLElement, extractedLabel?: string): boolean {
    if (el instanceof HTMLInputElement) {
      if (el.type === 'password' || el.type === 'hidden' || el.type === 'file') return true;
    }
    const autocomplete = (el.getAttribute('autocomplete') || '').toLowerCase();
    for (const p of SENSITIVE_AUTOCOMPLETE) {
      if (autocomplete.includes(p)) return true;
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

  function normalizeAndCleanLabel(text: string): string {
    let cleaned = text
      .replace(/\s*Required question\s*/gi, '')
      .replace(/[\s*]+$/, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleaned) cleaned = text.replace(/\s+/g, ' ').trim();
    return cleaned.length > 500 ? cleaned.substring(0, 497) + '...' : cleaned;
  }

  function getLabelText(el: HTMLElement): string {
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l?.textContent?.trim()) return normalizeAndCleanLabel(l.textContent);
    }

    const role = el.getAttribute('role')?.toLowerCase();
    const isRadio = (el instanceof HTMLInputElement && el.type === 'radio') || role === 'radio';
    if (isRadio) {
      const group = el.closest('[role="group"], [role="radiogroup"]');
      if (group) {
        const gLabel = group.getAttribute('aria-label');
        if (gLabel?.trim()) return normalizeAndCleanLabel(gLabel);
        const gLabelledby = group.getAttribute('aria-labelledby');
        if (gLabelledby) {
          const parts = gLabelledby
            .split(/\s+/)
            .map((refId) => document.getElementById(refId)?.textContent?.trim())
            .filter(Boolean);
          if (parts.length > 0) return normalizeAndCleanLabel(parts.join(' '));
        }
        const gHeading = group.querySelector(
          'h1, h2, h3, h4, h5, h6, [role="heading"], .group-label',
        );
        if (gHeading && gHeading.textContent?.trim() && !gHeading.contains(el)) {
          return normalizeAndCleanLabel(gHeading.textContent);
        }
      }
    }

    const wrap = el.closest('label');
    if (wrap?.textContent?.trim()) {
      const clone = wrap.cloneNode(true) as HTMLElement;
      clone.querySelectorAll('input, textarea, select').forEach((i) => i.remove());
      const t = clone.textContent?.trim();
      if (t) return normalizeAndCleanLabel(t);
    }
    const ariaLabelledby = el.getAttribute('aria-labelledby');
    if (ariaLabelledby) {
      const parts = ariaLabelledby
        .split(/\s+/)
        .map((refId) => document.getElementById(refId)?.textContent?.trim())
        .filter(Boolean);
      if (parts.length > 0) return normalizeAndCleanLabel(parts.join(' '));
    }
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel?.trim()) return normalizeAndCleanLabel(ariaLabel);

    const fieldset = el.closest('fieldset');
    if (fieldset) {
      const leg = fieldset.querySelector('legend');
      if (leg?.textContent?.trim()) return normalizeAndCleanLabel(leg.textContent);
    }

    const groupContainer = el.closest('[role="radiogroup"], [role="group"]');
    if (groupContainer) {
      const gAria = groupContainer.getAttribute('aria-label');
      if (gAria?.trim()) return normalizeAndCleanLabel(gAria);
      const gLabelledby = groupContainer.getAttribute('aria-labelledby');
      if (gLabelledby) {
        const parts = gLabelledby
          .split(/\s+/)
          .map((refId) => document.getElementById(refId)?.textContent?.trim())
          .filter(Boolean);
        if (parts.length > 0) return normalizeAndCleanLabel(parts.join(' '));
      }
    }

    const questionCard = el.closest(
      '[role="listitem"], .form-group, .question, .question-card, .field, .form-row, .field-wrapper',
    );
    if (questionCard) {
      const heading = questionCard.querySelector<HTMLElement>(
        'h1, h2, h3, h4, h5, h6, [role="heading"], .question-title, .field-label',
      );
      if (heading?.textContent?.trim() && !heading.contains(el)) {
        return normalizeAndCleanLabel(heading.textContent);
      }
    }

    const prevElem = el.previousElementSibling;
    if (prevElem && prevElem.textContent?.trim() && prevElem.textContent.trim().length < 200) {
      return normalizeAndCleanLabel(prevElem.textContent);
    }

    const placeholder = el.getAttribute('placeholder');
    if (placeholder?.trim()) return normalizeAndCleanLabel(placeholder);

    const name = el.getAttribute('name');
    if (name?.trim()) return normalizeAndCleanLabel(name);

    const id = el.getAttribute('id');
    if (id?.trim()) return normalizeAndCleanLabel(id);

    return '';
  }

  function getFieldValue(el: HTMLElement): string {
    const role = el.getAttribute('role')?.toLowerCase();
    if (role === 'radio') {
      const isChecked =
        el.getAttribute('aria-checked') === 'true' ||
        el.classList.contains('checked') ||
        el.classList.contains('is-checked');
      if (isChecked) {
        const val =
          el.getAttribute('data-value') ||
          el.getAttribute('aria-label') ||
          el.textContent?.trim() ||
          'Selected';
        return val.replace(/\s+/g, ' ').trim();
      }
      return '';
    }
    if (role === 'checkbox') {
      const isChecked =
        el.getAttribute('aria-checked') === 'true' ||
        el.classList.contains('checked') ||
        el.classList.contains('is-checked');
      return isChecked ? 'Checked' : '';
    }
    if (role === 'textbox') {
      const val = el.textContent || (el as HTMLElement).innerText || el.getAttribute('value') || '';
      return val.replace(/\s+/g, ' ').trim();
    }
    if (el instanceof HTMLInputElement) {
      if (el.type === 'checkbox') return el.checked ? 'Checked' : '';
      if (el.type === 'radio') {
        if (el.checked) {
          const l = getLabelText(el);
          return l || el.value || 'Selected';
        }
        return '';
      }
      if (el.type === 'file') {
        return el.files && el.files.length > 0
          ? `${Array.from(el.files)
              .map((f) => f.name)
              .join(', ')} selected`
          : '';
      }
      return el.value.trim();
    }
    if (el instanceof HTMLTextAreaElement) return el.value.trim();
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

  const CHAT_OR_COMPOSER_PATTERNS =
    /\b(chat|thread|conversation|composer|prompt-box|prompt-input|message-input|ai-box|chatbot|reply-box|comment-box|chat-input|chatbox|chat-window)\b/i;

  const CHAT_ACTION_PATTERNS =
    /^(send|stop|regenerate|ask|attach|mic|new chat|prompt|ask gemini|ask copilot)$/i;

  const EDITOR_CONTAINER_PATTERNS =
    /\b(canvas|designer|whiteboard|artboard|document-editor|design-editor|rich-text-editor|prosemirror|monaco-editor|ace_editor|ql-editor|canvas-container|page-container)\b/i;

  function isNonSubmissionContext(container: Element, elements: HTMLElement[]): boolean {
    const idAndClass = `${container.id} ${container.className}`.toLowerCase();

    let hasApplicationFields = false;
    let textControlCount = 0;

    for (const el of elements) {
      const type = el instanceof HTMLInputElement ? el.type.toLowerCase() : '';
      if (['email', 'tel', 'number', 'date'].includes(type)) {
        hasApplicationFields = true;
        break;
      }
      const label = getLabelText(el);
      if (
        label &&
        /name|email|phone|address|applicant|organization|grant|apply|job|proposal|inquiry|registration/i.test(
          label,
        )
      ) {
        hasApplicationFields = true;
        break;
      }
      if (
        el instanceof HTMLTextAreaElement ||
        type === 'text' ||
        el.getAttribute('role') === 'textbox' ||
        el.isContentEditable
      ) {
        textControlCount++;
      }
    }

    const hasEditorSemantics =
      EDITOR_CONTAINER_PATTERNS.test(idAndClass) ||
      Boolean(
        container.closest(
          '.canvas, [role="region"][aria-label*="canvas" i], .design-editor, .document-editor, .whiteboard, .artboard',
        ),
      );

    const hasToolbars = Boolean(
      container.querySelector(
        '[role="toolbar"], [role="menubar"], .toolbar, .formatting-bar, .editor-toolbar',
      ) || container.closest('[role="toolbar"], [role="menubar"], .toolbar'),
    );

    if ((hasEditorSemantics || hasToolbars) && !hasApplicationFields) {
      if (elements.length <= 4) {
        return true;
      }
    }

    const hasChatSemantics =
      CHAT_OR_COMPOSER_PATTERNS.test(idAndClass) ||
      Boolean(
        container.closest(
          '[role="log"], [role="marquee"], [class*="chat" i], [class*="thread" i], [class*="conversation" i], [class*="composer" i], [class*="prompt" i]',
        ),
      );

    const buttons = Array.from(
      container.querySelectorAll(
        'button, input[type="submit"], input[type="button"], div[role="button"]',
      ),
    );
    const hasChatAction = buttons.some((b) => {
      const text = (b.textContent || (b as HTMLInputElement).value || '').trim();
      return CHAT_ACTION_PATTERNS.test(text);
    });

    if (hasChatSemantics && !hasApplicationFields) {
      if (elements.length <= 3) {
        return true;
      }
    }

    if (textControlCount === 1 && elements.length <= 2 && hasChatAction && !hasApplicationFields) {
      return true;
    }

    return false;
  }

  function isVolatileId(id: string): boolean {
    if (!id) return true;
    const trimmed = id.trim();
    if (/^(:r\w+:|react-aria|ember\d+|__BVID__|ng-|v-\w+)/i.test(trimmed)) return true;
    if (/^\d+$/.test(trimmed)) return true;
    if (/^[a-f0-9]{8,}(-[a-f0-9]{4,})*$/i.test(trimmed)) return true;
    if (trimmed.length < 3) return true;
    return false;
  }

  function extractFormFamilyKey(container: Element | null | undefined): string {
    if (!container) return '';
    if (container instanceof HTMLFormElement) {
      const action = container.getAttribute('action');
      if (action && !action.startsWith('javascript:') && action !== '#' && action !== '') {
        try {
          const parsed = new URL(action, 'https://dummy.local');
          const cleanPath = parsed.pathname.toLowerCase().trim().replace(/\/+$/, '');
          const lastPart = cleanPath.split('/').pop() || '';
          if (cleanPath && cleanPath !== '/' && cleanPath !== '/#' && !isVolatileId(lastPart)) {
            return `action:${cleanPath}`;
          }
        } catch {
          // ignore
        }
      }
    }
    const name = container.getAttribute('name');
    if (name && !isVolatileId(name)) {
      return `name:${name.toLowerCase().trim()}`;
    }
    const id = container.getAttribute('id');
    if (id && !isVolatileId(id)) {
      return `id:${id.toLowerCase().trim()}`;
    }
    const ariaLabel = container.getAttribute('aria-label');
    if (
      ariaLabel &&
      ariaLabel.trim().length >= 3 &&
      ariaLabel.length <= 60 &&
      !isVolatileId(ariaLabel)
    ) {
      const norm = ariaLabel
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
      if (norm) return `label:${norm}`;
    }
    return '';
  }

  const allControls = collectControls(document.body || document.documentElement);
  if (allControls.length === 0) {
    const hasIframes = document.querySelectorAll('iframe').length > 0;
    return {
      formDetected: false,
      totalFields: 0,
      answeredCount: 0,
      score: 0,
      inaccessibleFrameDetected: hasIframes,
    };
  }

  interface ScoredCandidate {
    container: Element;
    totalFields: number;
    answeredCount: number;
    score: number;
    formFamilyKey?: string;
    detectedFields?: InjectedDetectedField[];
  }

  const assigned = new Set<HTMLElement>();
  const scoredCandidates: ScoredCandidate[] = [];

  // Grouping 1: Native <form> elements
  const forms = Array.from(document.querySelectorAll('form'));
  for (const form of forms) {
    const inside = allControls.filter((c) => form.contains(c));
    const associated = form.id
      ? allControls.filter(
          (c) =>
            !form.contains(c) &&
            (c.getAttribute('form') === form.id || (c as HTMLInputElement).form === form),
        )
      : [];
    const elements = Array.from(new Set([...inside, ...associated]));
    if (elements.length > 0) {
      elements.forEach((c) => assigned.add(c));
      evaluateCandidate(form, elements);
    }
  }

  // Grouping 2: [role="form"]
  const unassignedAfterForms = allControls.filter((c) => !assigned.has(c));
  const roleForms = Array.from(document.querySelectorAll('[role="form"]'));
  for (const rf of roleForms) {
    const matching = unassignedAfterForms.filter((c) => !assigned.has(c) && rf.contains(c));
    if (matching.length > 0) {
      matching.forEach((c) => assigned.add(c));
      evaluateCandidate(rf, matching);
    }
  }

  // Grouping 3: Semantic SPA containers or Question card lists
  const unassignedAfterRoles = allControls.filter((c) => !assigned.has(c));
  if (unassignedAfterRoles.length > 0) {
    const containers = Array.from(
      document.querySelectorAll(
        '[role="tabpanel"], [role="region"], [role="list"], fieldset, section, article, div, main',
      ),
    ).filter((el) => {
      if (el === document.body || el === document.documentElement) return false;
      const idAndClass = `${el.id} ${el.className}`.toLowerCase();
      const role = el.getAttribute('role')?.toLowerCase();

      const questionCardCount = el.querySelectorAll(
        '[role="listitem"], .question-card, .question, .form-group, .field-wrapper',
      ).length;

      const buttons = Array.from(
        el.querySelectorAll(
          'button, input[type="submit"], input[type="button"], a.btn, div[role="button"]',
        ),
      );
      const hasWorkflowBtn = buttons.some((b) =>
        SUBMIT_BUTTON_PATTERNS.test((b.textContent || (b as HTMLInputElement).value || '').trim()),
      );

      const hasStepIndicator =
        /page\s+\d+\s*[-of/]+\s*\d+/i.test(el.textContent || '') ||
        Boolean(el.querySelector('.step, .form-step, .tab-pane, [role="tabpanel"]'));

      const containsControls =
        el.querySelectorAll(
          'input, textarea, select, [role="radio"], [role="checkbox"], [role="textbox"]',
        ).length >= 2;

      return (
        role === 'tabpanel' ||
        role === 'region' ||
        (role === 'list' && containsControls) ||
        el.tagName.toLowerCase() === 'fieldset' ||
        el.tagName.toLowerCase() === 'section' ||
        APPLICATION_PATTERNS.test(idAndClass) ||
        (questionCardCount >= 2 && containsControls) ||
        (hasWorkflowBtn && containsControls) ||
        (hasStepIndicator && containsControls)
      );
    });

    containers.sort((a, b) => {
      const aHasBtn = a.querySelector(
        'button, [role="button"], input[type="submit"], input[type="button"]',
      )
        ? 1
        : 0;
      const bHasBtn = b.querySelector(
        'button, [role="button"], input[type="submit"], input[type="button"]',
      )
        ? 1
        : 0;
      if (aHasBtn !== bHasBtn) return bHasBtn - aHasBtn;
      const aCtrlCount = unassignedAfterRoles.filter((c) => a.contains(c)).length;
      const bCtrlCount = unassignedAfterRoles.filter((c) => b.contains(c)).length;
      return bCtrlCount - aCtrlCount;
    });

    for (const c of containers) {
      const matching = unassignedAfterRoles.filter(
        (ctrl) => !assigned.has(ctrl) && c.contains(ctrl),
      );
      if (
        matching.length >= 2 ||
        (matching.length >= 1 && matching.some((ctrl) => ctrl instanceof HTMLTextAreaElement))
      ) {
        matching.forEach((ctrl) => assigned.add(ctrl));
        evaluateCandidate(c, matching);
      }
    }
  }

  // Grouping 4: Proximity clusters for remaining controls
  const remaining = allControls.filter((c) => !assigned.has(c));
  if (remaining.length > 0) {
    const clusters = new Map<Element, HTMLElement[]>();
    for (const ctrl of remaining) {
      let parent: Element | null = ctrl.parentElement;
      while (
        parent &&
        parent !== document.body &&
        parent !== document.documentElement &&
        parent.tagName.toLowerCase() !== 'main' &&
        parent.parentElement &&
        parent.parentElement !== document.body &&
        parent.querySelectorAll(
          'input, textarea, select, [role="radio"], [role="checkbox"], [role="textbox"]',
        ).length <= 20
      ) {
        const isSingleCard =
          parent.getAttribute('role') === 'listitem' ||
          parent.classList.contains('question') ||
          parent.classList.contains('question-card') ||
          parent.classList.contains('form-group') ||
          parent.classList.contains('field-wrapper') ||
          parent.querySelectorAll(
            'input, textarea, select, [role="radio"], [role="checkbox"], [role="textbox"]',
          ).length <= 1;

        if (
          !isSingleCard &&
          (parent.tagName.toLowerCase() === 'div' ||
            parent.tagName.toLowerCase() === 'section' ||
            parent.tagName.toLowerCase() === 'article' ||
            parent.tagName.toLowerCase() === 'fieldset')
        ) {
          break;
        }
        parent = parent.parentElement;
      }
      const clusterCont = parent || ctrl.parentElement || document.body;
      const list = clusters.get(clusterCont) || [];
      list.push(ctrl);
      clusters.set(clusterCont, list);
    }

    for (const [cont, clusterCtrls] of clusters.entries()) {
      evaluateCandidate(cont, clusterCtrls);
    }
  }

  function evaluateCandidate(container: Element, elements: HTMLElement[]) {
    if (isUtility(container) || isNonSubmissionContext(container, elements)) return;

    let totalMeaningful = 0;
    let answered = 0;
    let score = 0;
    let textareaCount = 0;
    const seenRadioGroups = new Set<string>();
    const labelsSeen = new Set<string>();
    const detectedFields: InjectedDetectedField[] = [];

    for (const el of elements) {
      const label = getLabelText(el);
      if (isSensitive(el, label)) {
        totalMeaningful++;
        const sensLabel = label || 'Sensitive Field';
        detectedFields.push({ label: sensLabel, fieldType: 'password', excluded: true });
        continue;
      }

      if (!label) continue;

      const role = el.getAttribute('role')?.toLowerCase();
      const isRadio = (el instanceof HTMLInputElement && el.type === 'radio') || role === 'radio';
      if (isRadio) {
        let groupKey = el.getAttribute('name') || '';
        const groupContainer = el.closest('[role="radiogroup"], [role="group"]');
        if (!groupKey) {
          if (groupContainer) {
            groupKey =
              groupContainer.id ||
              groupContainer.getAttribute('aria-label') ||
              groupContainer.getAttribute('aria-labelledby') ||
              'radiogroup';
          } else {
            const card = el.closest(
              '[role="listitem"], .question-card, .question, .form-group, .field',
            );
            groupKey = card?.id || 'radiogroup';
          }
        }
        if (seenRadioGroups.has(groupKey)) continue;
        seenRadioGroups.add(groupKey);
        totalMeaningful++;
        score += 15;
        labelsSeen.add(label.toLowerCase());
        detectedFields.push({ label, fieldType: 'radio', excluded: false });

        let isAnyChecked = false;
        if (el instanceof HTMLInputElement && el.name) {
          isAnyChecked = Boolean(
            container.querySelector(`input[type="radio"][name="${CSS.escape(el.name)}"]:checked`),
          );
        } else if (groupContainer) {
          isAnyChecked = Array.from(groupContainer.querySelectorAll('[role="radio"]')).some(
            (r) =>
              r.getAttribute('aria-checked') === 'true' ||
              r.classList.contains('checked') ||
              r.classList.contains('is-checked'),
          );
        } else {
          isAnyChecked =
            el.getAttribute('aria-checked') === 'true' ||
            el.classList.contains('checked') ||
            el.classList.contains('is-checked');
        }
        if (isAnyChecked) answered++;
        continue;
      }

      totalMeaningful++;
      labelsSeen.add(label.toLowerCase());

      const val = getFieldValue(el);
      if (val) answered++;

      let type = 'text';
      if (el instanceof HTMLTextAreaElement) {
        type = 'textarea';
        textareaCount++;
        score += 25;
      } else if (
        el instanceof HTMLInputElement &&
        ['email', 'tel', 'url', 'number', 'date'].includes(el.type)
      ) {
        type = el.type;
        score += 15;
      } else if (el instanceof HTMLSelectElement) {
        type = 'select';
        score += 12;
      } else if (el instanceof HTMLInputElement && el.type === 'checkbox') {
        type = 'checkbox';
        score += 12;
      } else {
        score += 10;
      }
      detectedFields.push({ label, fieldType: type, excluded: false });
    }

    if (totalMeaningful >= 2) score += 15;
    if (totalMeaningful >= 4) score += 20;
    if (totalMeaningful >= 8) score += 25;
    if (textareaCount >= 2) score += 30;
    if (labelsSeen.size >= 3) score += 15;

    if (container.tagName.toLowerCase() === 'form') score += 15;
    if (container.getAttribute('role') === 'form') score += 15;

    const idAndClass = `${container.id} ${container.className}`.toLowerCase();
    if (APPLICATION_PATTERNS.test(idAndClass)) score += 20;

    // Multi-step / tabbed application structure
    if (
      container.querySelector(
        '[role="tabpanel"], [role="tablist"], .step, .tab-pane, .form-step',
      ) ||
      container.getAttribute('role') === 'tabpanel' ||
      /page\s+\d+\s*[-of/]+\s*\d+/i.test(container.textContent || '')
    ) {
      score += 15;
    }

    // Structured question list structure
    if (
      container.getAttribute('role') === 'list' ||
      container.querySelectorAll('[role="listitem"], .question-card').length >= 2
    ) {
      score += 15;
    }

    const btns = Array.from(
      container.querySelectorAll(
        'button, input[type="submit"], input[type="button"], a.btn, div[role="button"]',
      ),
    );
    const hasWorkflow = btns.some((b) => {
      const txt = (b.textContent || (b as HTMLInputElement).value || '').trim();
      return SUBMIT_BUTTON_PATTERNS.test(txt);
    });
    if (hasWorkflow) score += 25;

    if (answered > 0) score += Math.min(answered * 3, 15);

    if (totalMeaningful < 2 && textareaCount === 0) {
      score -= 50;
    } else if (
      totalMeaningful <= 2 &&
      textareaCount === 0 &&
      !hasWorkflow &&
      !APPLICATION_PATTERNS.test(idAndClass)
    ) {
      score -= 40;
    }

    if (score >= 30 && totalMeaningful >= 1) {
      scoredCandidates.push({
        container,
        totalFields: totalMeaningful,
        answeredCount: answered,
        score,
        formFamilyKey: extractFormFamilyKey(container),
        detectedFields,
      });
    }
  }

  const hasIframes = document.querySelectorAll('iframe').length > 0;
  if (scoredCandidates.length === 0) {
    return {
      formDetected: false,
      totalFields: 0,
      answeredCount: 0,
      score: 0,
      inaccessibleFrameDetected: hasIframes,
    };
  }

  scoredCandidates.sort((a, b) => b.score - a.score);
  const best = scoredCandidates[0];
  if (!best) {
    return {
      formDetected: false,
      totalFields: 0,
      answeredCount: 0,
      score: 0,
      inaccessibleFrameDetected: hasIframes,
    };
  }

  return {
    formDetected: true,
    totalFields: best.totalFields,
    answeredCount: best.answeredCount,
    score: best.score,
    formFamilyKey: best.formFamilyKey || '',
    inaccessibleFrameDetected: false,
    detectedFields: best.detectedFields,
  };
}

/**
 * Backwards compatibility alias for countFormFields.
 */
export function countFormFields(): InjectedScanResult {
  return scanPageForms();
}

/**
 * Captures non-empty answers and sensitive fields from the highest-scoring candidate.
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

  const SEARCH_PATTERNS = /search|lookup|find|query|filter|nav|toolbar/i;
  const APPLICATION_PATTERNS =
    /app|apply|grant|register|signup|contact|proposal|inquiry|feedback|survey|checkout|order|portal|form|intake|submission/i;
  const SUBMIT_BUTTON_PATTERNS =
    /submit|apply|send|save.?draft|save|register|complete|finish|continue|next|review|proceed|confirm/i;

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

  function collectControls(root: ParentNode): HTMLElement[] {
    const controls: HTMLElement[] = [];
    function walk(node: Node) {
      if (node instanceof HTMLElement) {
        const tag = node.tagName.toLowerCase();
        let isControl = false;
        if (tag === 'input' || tag === 'textarea' || tag === 'select') {
          const type = tag === 'input' ? (node as HTMLInputElement).type.toLowerCase() : '';
          if (
            type !== 'hidden' &&
            type !== 'submit' &&
            type !== 'button' &&
            type !== 'image' &&
            type !== 'reset' &&
            type !== 'file'
          ) {
            isControl = true;
          }
        } else {
          const role = node.getAttribute('role')?.toLowerCase();
          if (
            role === 'radio' ||
            role === 'checkbox' ||
            role === 'textbox' ||
            role === 'combobox' ||
            role === 'listbox' ||
            (node.isContentEditable && !node.parentElement?.isContentEditable)
          ) {
            isControl = true;
          }
        }
        if (isControl && isVisible(node)) {
          controls.push(node);
          const role = node.getAttribute('role')?.toLowerCase();
          if (
            tag === 'input' ||
            tag === 'textarea' ||
            tag === 'select' ||
            role === 'radio' ||
            role === 'checkbox'
          ) {
            if (node.shadowRoot) walk(node.shadowRoot);
            return;
          }
        }
        if (node.shadowRoot) walk(node.shadowRoot);
      }
      const children = (node as Element).children || node.childNodes;
      if (children) {
        for (let i = 0; i < children.length; i++) {
          const child = children[i];
          if (child) walk(child);
        }
      }
    }
    walk(root);
    return controls;
  }

  function isUtility(container: Element): boolean {
    const role = container.getAttribute('role')?.toLowerCase();
    if (role === 'search' || role === 'navigation' || role === 'toolbar' || role === 'menubar') {
      return true;
    }
    if (container.closest('nav, [role="navigation"], [role="toolbar"], [role="search"]')) {
      return true;
    }

    const inputs = Array.from(container.querySelectorAll('input'));
    const textareas = container.querySelectorAll('textarea');
    const idAndClass = `${container.id} ${container.className}`.toLowerCase();

    if (
      SEARCH_PATTERNS.test(idAndClass) &&
      !APPLICATION_PATTERNS.test(idAndClass) &&
      textareas.length === 0
    ) {
      if (inputs.length <= 4) return true;
    }

    const hasSearchOrFilterInput = inputs.some(
      (inp) =>
        inp.type === 'search' ||
        inp.name === 'q' ||
        inp.name === 'query' ||
        inp.name === 'search' ||
        inp.name.includes('filter') ||
        inp.id.includes('filter') ||
        inp.getAttribute('aria-label')?.toLowerCase().includes('search'),
    );
    if (hasSearchOrFilterInput && inputs.length <= 3 && textareas.length === 0) {
      return true;
    }

    if (container instanceof HTMLFormElement) {
      const combined = `${container.getAttribute('action') || ''} ${container.getAttribute('name') || ''} ${idAndClass}`;
      if (
        SEARCH_PATTERNS.test(combined) &&
        !APPLICATION_PATTERNS.test(combined) &&
        textareas.length === 0
      ) {
        if (inputs.length <= 4) return true;
      }
    }
    return false;
  }

  function isSensitive(el: HTMLElement, extractedLabel?: string): boolean {
    if (el instanceof HTMLInputElement) {
      if (el.type === 'password' || el.type === 'hidden' || el.type === 'file') return true;
    }
    const autocomplete = (el.getAttribute('autocomplete') || '').toLowerCase();
    for (const p of SENSITIVE_AUTOCOMPLETE) {
      if (autocomplete.includes(p)) return true;
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

  function normalizeAndCleanLabel(text: string): string {
    let cleaned = text
      .replace(/\s*Required question\s*/gi, '')
      .replace(/[\s*]+$/, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleaned) cleaned = text.replace(/\s+/g, ' ').trim();
    return cleaned.length > 500 ? cleaned.substring(0, 497) + '...' : cleaned;
  }

  function getLabelText(el: HTMLElement): string {
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l?.textContent?.trim()) {
        return normalizeAndCleanLabel(l.textContent);
      }
    }

    const role = el.getAttribute('role')?.toLowerCase();
    const isRadio = (el instanceof HTMLInputElement && el.type === 'radio') || role === 'radio';
    if (isRadio) {
      const group = el.closest('[role="group"], [role="radiogroup"]');
      if (group) {
        const gLabel = group.getAttribute('aria-label');
        if (gLabel?.trim()) return normalizeAndCleanLabel(gLabel);
        const gLabelledby = group.getAttribute('aria-labelledby');
        if (gLabelledby) {
          const parts = gLabelledby
            .split(/\s+/)
            .map((refId) => document.getElementById(refId)?.textContent?.trim())
            .filter(Boolean);
          if (parts.length > 0) return normalizeAndCleanLabel(parts.join(' '));
        }
        const gHeading = group.querySelector(
          'h1, h2, h3, h4, h5, h6, [role="heading"], .group-label',
        );
        if (gHeading && gHeading.textContent?.trim() && !gHeading.contains(el)) {
          return normalizeAndCleanLabel(gHeading.textContent);
        }
      }
    }

    const wrap = el.closest('label');
    if (wrap?.textContent?.trim()) {
      const clone = wrap.cloneNode(true) as HTMLElement;
      clone.querySelectorAll('input, textarea, select').forEach((i) => i.remove());
      const t = clone.textContent?.trim();
      if (t) return normalizeAndCleanLabel(t);
    }
    const ariaLabelledby = el.getAttribute('aria-labelledby');
    if (ariaLabelledby) {
      const parts = ariaLabelledby
        .split(/\s+/)
        .map((refId) => document.getElementById(refId)?.textContent?.trim())
        .filter(Boolean);
      if (parts.length > 0) {
        return normalizeAndCleanLabel(parts.join(' '));
      }
    }
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel?.trim()) {
      return normalizeAndCleanLabel(ariaLabel);
    }

    const fieldset = el.closest('fieldset');
    if (fieldset) {
      const leg = fieldset.querySelector('legend');
      if (leg?.textContent?.trim()) {
        return normalizeAndCleanLabel(leg.textContent);
      }
    }

    const groupContainer = el.closest('[role="radiogroup"], [role="group"]');
    if (groupContainer) {
      const gAria = groupContainer.getAttribute('aria-label');
      if (gAria?.trim()) return normalizeAndCleanLabel(gAria);
      const gLabelledby = groupContainer.getAttribute('aria-labelledby');
      if (gLabelledby) {
        const parts = gLabelledby
          .split(/\s+/)
          .map((refId) => document.getElementById(refId)?.textContent?.trim())
          .filter(Boolean);
        if (parts.length > 0) return normalizeAndCleanLabel(parts.join(' '));
      }
    }

    const questionCard = el.closest(
      '[role="listitem"], .form-group, .question, .question-card, .field, .form-row, .field-wrapper',
    );
    if (questionCard) {
      const heading = questionCard.querySelector<HTMLElement>(
        'h1, h2, h3, h4, h5, h6, [role="heading"], .question-title, .field-label',
      );
      if (heading?.textContent?.trim() && !heading.contains(el)) {
        return normalizeAndCleanLabel(heading.textContent);
      }
    }

    const prevElem = el.previousElementSibling;
    if (prevElem && prevElem.textContent?.trim() && prevElem.textContent.trim().length < 200) {
      return normalizeAndCleanLabel(prevElem.textContent);
    }

    const placeholder = el.getAttribute('placeholder');
    if (placeholder?.trim()) {
      return normalizeAndCleanLabel(placeholder);
    }

    const name = el.getAttribute('name');
    if (name?.trim()) {
      return normalizeAndCleanLabel(name);
    }

    const id = el.getAttribute('id');
    if (id?.trim()) {
      return normalizeAndCleanLabel(id);
    }

    return '';
  }

  function getFieldValue(el: HTMLElement): string {
    const role = el.getAttribute('role')?.toLowerCase();
    if (role === 'radio') {
      const isChecked =
        el.getAttribute('aria-checked') === 'true' ||
        el.classList.contains('checked') ||
        el.classList.contains('is-checked');
      if (isChecked) {
        const val =
          el.getAttribute('data-value') ||
          el.getAttribute('aria-label') ||
          el.textContent?.trim() ||
          'Selected';
        return val.replace(/\s+/g, ' ').trim();
      }
      return '';
    }
    if (role === 'checkbox') {
      const isChecked =
        el.getAttribute('aria-checked') === 'true' ||
        el.classList.contains('checked') ||
        el.classList.contains('is-checked');
      return isChecked ? 'Checked' : '';
    }
    if (role === 'textbox') {
      const val = el.textContent || (el as HTMLElement).innerText || el.getAttribute('value') || '';
      return val.replace(/\s+/g, ' ').trim();
    }
    if (el instanceof HTMLInputElement) {
      if (el.type === 'checkbox') return el.checked ? 'Checked' : '';
      if (el.type === 'radio') {
        if (el.checked) {
          const l = getLabelText(el);
          return l || el.value || 'Selected';
        }
        return '';
      }
      if (el.type === 'file') {
        return el.files && el.files.length > 0
          ? `${Array.from(el.files)
              .map((f) => f.name)
              .join(', ')} selected`
          : '';
      }
      return el.value.trim();
    }
    if (el instanceof HTMLTextAreaElement) return el.value.trim();
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

  const CHAT_OR_COMPOSER_PATTERNS =
    /\b(chat|thread|conversation|composer|prompt-box|prompt-input|message-input|ai-box|chatbot|reply-box|comment-box|chat-input|chatbox|chat-window)\b/i;

  const CHAT_ACTION_PATTERNS =
    /^(send|stop|regenerate|ask|attach|mic|new chat|prompt|ask gemini|ask copilot)$/i;

  const EDITOR_CONTAINER_PATTERNS =
    /\b(canvas|designer|whiteboard|artboard|document-editor|design-editor|rich-text-editor|prosemirror|monaco-editor|ace_editor|ql-editor|canvas-container|page-container)\b/i;

  function isNonSubmissionContext(container: Element, elements: HTMLElement[]): boolean {
    const idAndClass = `${container.id} ${container.className}`.toLowerCase();

    let hasApplicationFields = false;
    let textControlCount = 0;

    for (const el of elements) {
      const type = el instanceof HTMLInputElement ? el.type.toLowerCase() : '';
      if (['email', 'tel', 'number', 'date'].includes(type)) {
        hasApplicationFields = true;
        break;
      }
      const label = getLabelText(el);
      if (
        label &&
        /name|email|phone|address|applicant|organization|grant|apply|job|proposal|inquiry|registration/i.test(
          label,
        )
      ) {
        hasApplicationFields = true;
        break;
      }
      if (
        el instanceof HTMLTextAreaElement ||
        type === 'text' ||
        el.getAttribute('role') === 'textbox' ||
        el.isContentEditable
      ) {
        textControlCount++;
      }
    }

    const hasEditorSemantics =
      EDITOR_CONTAINER_PATTERNS.test(idAndClass) ||
      Boolean(
        container.closest(
          '.canvas, [role="region"][aria-label*="canvas" i], .design-editor, .document-editor, .whiteboard, .artboard',
        ),
      );

    const hasToolbars = Boolean(
      container.querySelector(
        '[role="toolbar"], [role="menubar"], .toolbar, .formatting-bar, .editor-toolbar',
      ) || container.closest('[role="toolbar"], [role="menubar"], .toolbar'),
    );

    if ((hasEditorSemantics || hasToolbars) && !hasApplicationFields) {
      if (elements.length <= 4) {
        return true;
      }
    }

    const hasChatSemantics =
      CHAT_OR_COMPOSER_PATTERNS.test(idAndClass) ||
      Boolean(
        container.closest(
          '[role="log"], [role="marquee"], [class*="chat" i], [class*="thread" i], [class*="conversation" i], [class*="composer" i], [class*="prompt" i]',
        ),
      );

    const buttons = Array.from(
      container.querySelectorAll(
        'button, input[type="submit"], input[type="button"], div[role="button"]',
      ),
    );
    const hasChatAction = buttons.some((b) => {
      const text = (b.textContent || (b as HTMLInputElement).value || '').trim();
      return CHAT_ACTION_PATTERNS.test(text);
    });

    if (hasChatSemantics && !hasApplicationFields) {
      if (elements.length <= 3) {
        return true;
      }
    }

    if (textControlCount === 1 && elements.length <= 2 && hasChatAction && !hasApplicationFields) {
      return true;
    }

    return false;
  }

  function isVolatileId(id: string): boolean {
    if (!id) return true;
    const trimmed = id.trim();
    if (/^(:r\w+:|react-aria|ember\d+|__BVID__|ng-|v-\w+)/i.test(trimmed)) return true;
    if (/^\d+$/.test(trimmed)) return true;
    if (/^[a-f0-9]{8,}(-[a-f0-9]{4,})*$/i.test(trimmed)) return true;
    if (trimmed.length < 3) return true;
    return false;
  }

  function extractFormFamilyKey(container: Element | null | undefined): string {
    if (!container) return '';
    if (container instanceof HTMLFormElement) {
      const action = container.getAttribute('action');
      if (action && !action.startsWith('javascript:') && action !== '#' && action !== '') {
        try {
          const parsed = new URL(action, 'https://dummy.local');
          const cleanPath = parsed.pathname.toLowerCase().trim().replace(/\/+$/, '');
          const lastPart = cleanPath.split('/').pop() || '';
          if (cleanPath && cleanPath !== '/' && cleanPath !== '/#' && !isVolatileId(lastPart)) {
            return `action:${cleanPath}`;
          }
        } catch {
          // ignore
        }
      }
    }
    const name = container.getAttribute('name');
    if (name && !isVolatileId(name)) {
      return `name:${name.toLowerCase().trim()}`;
    }
    const id = container.getAttribute('id');
    if (id && !isVolatileId(id)) {
      return `id:${id.toLowerCase().trim()}`;
    }
    const ariaLabel = container.getAttribute('aria-label');
    if (
      ariaLabel &&
      ariaLabel.trim().length >= 3 &&
      ariaLabel.length <= 60 &&
      !isVolatileId(ariaLabel)
    ) {
      const norm = ariaLabel
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
      if (norm) return `label:${norm}`;
    }
    return '';
  }

  const allControls = collectControls(document.body || document.documentElement);
  if (allControls.length === 0) {
    const hasIframes = document.querySelectorAll('iframe').length > 0;
    return {
      formDetected: false,
      fields: [],
      excludedCount: 0,
      totalDetected: 0,
      includedCount: 0,
      answeredCount: 0,
      inaccessibleFrameDetected: hasIframes,
    };
  }

  interface ProcessedCandidate {
    fields: InjectedCapturedField[];
    score: number;
    excludedCount: number;
    totalDetected: number;
    answeredCount: number;
    formFamilyKey?: string;
    detectedFields?: InjectedDetectedField[];
  }

  const assigned = new Set<HTMLElement>();
  const candidates: ProcessedCandidate[] = [];

  // Grouping 1: Native <form> elements
  const forms = Array.from(document.querySelectorAll('form'));
  for (const form of forms) {
    const inside = allControls.filter((c) => form.contains(c));
    const associated = form.id
      ? allControls.filter(
          (c) =>
            !form.contains(c) &&
            (c.getAttribute('form') === form.id || (c as HTMLInputElement).form === form),
        )
      : [];
    const elements = Array.from(new Set([...inside, ...associated]));
    if (elements.length > 0) {
      elements.forEach((c) => assigned.add(c));
      evaluateCandidate(form, elements);
    }
  }

  // Grouping 2: [role="form"]
  const unassignedAfterForms = allControls.filter((c) => !assigned.has(c));
  const roleForms = Array.from(document.querySelectorAll('[role="form"]'));
  for (const rf of roleForms) {
    const matching = unassignedAfterForms.filter((c) => !assigned.has(c) && rf.contains(c));
    if (matching.length > 0) {
      matching.forEach((c) => assigned.add(c));
      evaluateCandidate(rf, matching);
    }
  }

  // Grouping 3: Semantic containers and Question card lists
  const unassignedAfterRoles = allControls.filter((c) => !assigned.has(c));
  if (unassignedAfterRoles.length > 0) {
    const containers = Array.from(
      document.querySelectorAll(
        '[role="tabpanel"], [role="region"], [role="list"], fieldset, section, article, div, main',
      ),
    ).filter((el) => {
      if (el === document.body || el === document.documentElement) return false;
      const idAndClass = `${el.id} ${el.className}`.toLowerCase();
      const role = el.getAttribute('role')?.toLowerCase();

      const questionCardCount = el.querySelectorAll(
        '[role="listitem"], .question-card, .question, .form-group, .field-wrapper',
      ).length;

      const buttons = Array.from(
        el.querySelectorAll(
          'button, input[type="submit"], input[type="button"], a.btn, div[role="button"]',
        ),
      );
      const hasWorkflowBtn = buttons.some((b) =>
        SUBMIT_BUTTON_PATTERNS.test((b.textContent || (b as HTMLInputElement).value || '').trim()),
      );

      const hasStepIndicator =
        /page\s+\d+\s*[-of/]+\s*\d+/i.test(el.textContent || '') ||
        Boolean(el.querySelector('.step, .form-step, .tab-pane, [role="tabpanel"]'));

      const containsControls =
        el.querySelectorAll(
          'input, textarea, select, [role="radio"], [role="checkbox"], [role="textbox"]',
        ).length >= 2;

      return (
        role === 'tabpanel' ||
        role === 'region' ||
        (role === 'list' && containsControls) ||
        el.tagName.toLowerCase() === 'fieldset' ||
        el.tagName.toLowerCase() === 'section' ||
        APPLICATION_PATTERNS.test(idAndClass) ||
        (questionCardCount >= 2 && containsControls) ||
        (hasWorkflowBtn && containsControls) ||
        (hasStepIndicator && containsControls)
      );
    });

    containers.sort((a, b) => {
      const aHasBtn = a.querySelector(
        'button, [role="button"], input[type="submit"], input[type="button"]',
      )
        ? 1
        : 0;
      const bHasBtn = b.querySelector(
        'button, [role="button"], input[type="submit"], input[type="button"]',
      )
        ? 1
        : 0;
      if (aHasBtn !== bHasBtn) return bHasBtn - aHasBtn;
      const aCtrlCount = unassignedAfterRoles.filter((c) => a.contains(c)).length;
      const bCtrlCount = unassignedAfterRoles.filter((c) => b.contains(c)).length;
      return bCtrlCount - aCtrlCount;
    });

    for (const c of containers) {
      const matching = unassignedAfterRoles.filter(
        (ctrl) => !assigned.has(ctrl) && c.contains(ctrl),
      );
      if (
        matching.length >= 2 ||
        (matching.length >= 1 && matching.some((ctrl) => ctrl instanceof HTMLTextAreaElement))
      ) {
        matching.forEach((ctrl) => assigned.add(ctrl));
        evaluateCandidate(c, matching);
      }
    }
  }

  // Grouping 4: Proximity clusters
  const remaining = allControls.filter((c) => !assigned.has(c));
  if (remaining.length > 0) {
    const clusters = new Map<Element, HTMLElement[]>();
    for (const ctrl of remaining) {
      let parent: Element | null = ctrl.parentElement;
      while (
        parent &&
        parent !== document.body &&
        parent !== document.documentElement &&
        parent.tagName.toLowerCase() !== 'main' &&
        parent.parentElement &&
        parent.parentElement !== document.body &&
        parent.querySelectorAll(
          'input, textarea, select, [role="radio"], [role="checkbox"], [role="textbox"]',
        ).length <= 20
      ) {
        const isSingleCard =
          parent.getAttribute('role') === 'listitem' ||
          parent.classList.contains('question') ||
          parent.classList.contains('question-card') ||
          parent.classList.contains('form-group') ||
          parent.classList.contains('field-wrapper') ||
          parent.querySelectorAll(
            'input, textarea, select, [role="radio"], [role="checkbox"], [role="textbox"]',
          ).length <= 1;

        if (
          !isSingleCard &&
          (parent.tagName.toLowerCase() === 'div' ||
            parent.tagName.toLowerCase() === 'section' ||
            parent.tagName.toLowerCase() === 'article' ||
            parent.tagName.toLowerCase() === 'fieldset')
        ) {
          break;
        }
        parent = parent.parentElement;
      }
      const clusterCont = parent || ctrl.parentElement || document.body;
      const list = clusters.get(clusterCont) || [];
      list.push(ctrl);
      clusters.set(clusterCont, list);
    }

    for (const [cont, clusterCtrls] of clusters.entries()) {
      evaluateCandidate(cont, clusterCtrls);
    }
  }

  function evaluateCandidate(container: Element, elements: HTMLElement[]) {
    if (isUtility(container) || isNonSubmissionContext(container, elements)) return;

    const fields: InjectedCapturedField[] = [];
    const detectedFields: InjectedDetectedField[] = [];
    let excludedCount = 0;
    let totalMeaningful = 0;
    let answered = 0;
    let score = 0;
    let textareaCount = 0;
    const seenRadioGroups = new Set<string>();
    const labelsSeen = new Set<string>();

    for (const el of elements) {
      const labelInfo = getLabelText(el);
      if (isSensitive(el, labelInfo)) {
        excludedCount++;
        totalMeaningful++;
        const fType =
          el instanceof HTMLTextAreaElement
            ? 'textarea'
            : el instanceof HTMLSelectElement
              ? 'select'
              : (el as HTMLInputElement).type || 'text';
        const sensLabel = labelInfo || 'Sensitive Field';
        detectedFields.push({ label: sensLabel, fieldType: fType, excluded: true });
        fields.push({
          id: crypto.randomUUID(),
          label: sensLabel,
          value: '',
          fieldType: fType,
          labelSource: 'unknown',
          excluded: true,
          excludeReason: 'Sensitive field excluded for privacy',
        });
        continue;
      }

      if (!labelInfo) continue; // Unknown Field Policy: exclude unlabeled controls

      const role = el.getAttribute('role')?.toLowerCase();
      const isRadio = (el instanceof HTMLInputElement && el.type === 'radio') || role === 'radio';
      if (isRadio) {
        let groupKey = el.getAttribute('name') || '';
        const groupContainer = el.closest('[role="radiogroup"], [role="group"]');
        if (!groupKey) {
          if (groupContainer) {
            groupKey =
              groupContainer.id ||
              groupContainer.getAttribute('aria-label') ||
              groupContainer.getAttribute('aria-labelledby') ||
              'radiogroup';
          } else {
            const card = el.closest(
              '[role="listitem"], .question-card, .question, .form-group, .field',
            );
            groupKey = card?.id || 'radiogroup';
          }
        }
        if (seenRadioGroups.has(groupKey)) continue;
        seenRadioGroups.add(groupKey);
        totalMeaningful++;
        score += 15;
        labelsSeen.add(labelInfo.toLowerCase());
        detectedFields.push({ label: labelInfo, fieldType: 'radio', excluded: false });

        let radioVal = '';
        if (el instanceof HTMLInputElement && el.name) {
          const radios = container.querySelectorAll<HTMLInputElement>(
            `input[type="radio"][name="${CSS.escape(el.name)}"]`,
          );
          const checked = Array.from(radios).find((r) => r.checked);
          if (checked) {
            const checkedLabel = getLabelText(checked);
            radioVal = checkedLabel || checked.value || 'Selected';
          }
        } else if (groupContainer) {
          const radios = Array.from(groupContainer.querySelectorAll<HTMLElement>('[role="radio"]'));
          const checked = radios.find(
            (r) =>
              r.getAttribute('aria-checked') === 'true' ||
              r.classList.contains('checked') ||
              r.classList.contains('is-checked'),
          );
          if (checked) {
            radioVal =
              checked.getAttribute('data-value') ||
              checked.getAttribute('aria-label') ||
              checked.textContent?.trim() ||
              'Selected';
          }
        } else {
          if (
            el.getAttribute('aria-checked') === 'true' ||
            el.classList.contains('checked') ||
            el.classList.contains('is-checked')
          ) {
            radioVal =
              el.getAttribute('data-value') ||
              el.getAttribute('aria-label') ||
              el.textContent?.trim() ||
              'Selected';
          }
        }

        if (radioVal) {
          answered++;
          fields.push({
            id: crypto.randomUUID(),
            label: labelInfo,
            value: radioVal,
            fieldType: 'radio',
            labelSource: 'role-label',
            excluded: false,
          });
        }
        continue;
      }

      totalMeaningful++;
      labelsSeen.add(labelInfo.toLowerCase());

      // Checkbox group consolidation if multiple with same name
      if (el instanceof HTMLInputElement && el.type === 'checkbox' && el.name) {
        const sameName = container.querySelectorAll<HTMLInputElement>(
          `input[type="checkbox"][name="${CSS.escape(el.name)}"]`,
        );
        if (sameName.length > 1) {
          if (fields.some((f) => f.label === labelInfo)) continue;
          detectedFields.push({ label: labelInfo, fieldType: 'checkbox', excluded: false });
          const checkedBoxes = Array.from(sameName).filter((c) => c.checked);
          if (checkedBoxes.length > 0) {
            answered++;
            const checkedVals = checkedBoxes.map((c) => {
              const l = getLabelText(c);
              return l || c.value;
            });
            fields.push({
              id: crypto.randomUUID(),
              label: labelInfo,
              value: checkedVals.join(', '),
              fieldType: 'checkbox',
              labelSource: 'role-label',
              excluded: false,
            });
          }
          score += 15;
          continue;
        }
      }

      const fType =
        el instanceof HTMLTextAreaElement
          ? 'textarea'
          : el instanceof HTMLSelectElement
            ? 'select'
            : (el as HTMLInputElement).type || (role === 'textbox' ? 'text' : role || 'text');
      detectedFields.push({ label: labelInfo, fieldType: fType, excluded: false });

      const val = getFieldValue(el);
      if (val) {
        answered++;

        fields.push({
          id: crypto.randomUUID(),
          label: labelInfo,
          value: val,
          fieldType: fType,
          labelSource: 'label',
          excluded: false,
        });
      }

      if (el instanceof HTMLTextAreaElement) {
        textareaCount++;
        score += 25;
      } else if (
        el instanceof HTMLInputElement &&
        ['email', 'tel', 'url', 'number', 'date'].includes(el.type)
      ) {
        score += 15;
      } else if (
        el instanceof HTMLSelectElement ||
        (el instanceof HTMLInputElement && el.type === 'checkbox')
      ) {
        score += 12;
      } else {
        score += 10;
      }
    }

    if (totalMeaningful >= 2) score += 15;
    if (totalMeaningful >= 4) score += 20;
    if (totalMeaningful >= 8) score += 25;
    if (textareaCount >= 2) score += 30;
    if (labelsSeen.size >= 3) score += 15;

    if (container.tagName.toLowerCase() === 'form') score += 15;
    if (container.getAttribute('role') === 'form') score += 15;

    const idAndClass = `${container.id} ${container.className}`.toLowerCase();
    if (APPLICATION_PATTERNS.test(idAndClass)) score += 20;

    // Multi-step / tabbed application structure
    if (
      container.querySelector(
        '[role="tabpanel"], [role="tablist"], .step, .tab-pane, .form-step',
      ) ||
      container.getAttribute('role') === 'tabpanel' ||
      /page\s+\d+\s*[-of/]+\s*\d+/i.test(container.textContent || '')
    ) {
      score += 15;
    }

    // Structured question list structure
    if (
      container.getAttribute('role') === 'list' ||
      container.querySelectorAll('[role="listitem"], .question-card').length >= 2
    ) {
      score += 15;
    }

    const btns = Array.from(
      container.querySelectorAll(
        'button, input[type="submit"], input[type="button"], a.btn, div[role="button"]',
      ),
    );
    const hasWorkflow = btns.some((b) => {
      const txt = (b.textContent || (b as HTMLInputElement).value || '').trim();
      return SUBMIT_BUTTON_PATTERNS.test(txt);
    });
    if (hasWorkflow) score += 25;

    if (answered > 0) score += Math.min(answered * 3, 15);

    if (totalMeaningful < 2 && textareaCount === 0) {
      score -= 50;
    } else if (
      totalMeaningful <= 2 &&
      textareaCount === 0 &&
      !hasWorkflow &&
      !APPLICATION_PATTERNS.test(idAndClass)
    ) {
      score -= 40;
    }

    if (score >= 30 && totalMeaningful >= 1) {
      candidates.push({
        fields,
        score,
        excludedCount,
        totalDetected: totalMeaningful,
        answeredCount: answered,
        formFamilyKey: extractFormFamilyKey(container),
        detectedFields,
      });
    }
  }

  const hasIframes = document.querySelectorAll('iframe').length > 0;
  if (candidates.length === 0) {
    return {
      formDetected: false,
      fields: [],
      excludedCount: 0,
      totalDetected: 0,
      includedCount: 0,
      answeredCount: 0,
      inaccessibleFrameDetected: hasIframes,
    };
  }

  candidates.sort((a, b) => b.score - a.score);
  const winner = candidates[0];
  if (!winner) {
    return {
      formDetected: false,
      fields: [],
      excludedCount: 0,
      totalDetected: 0,
      includedCount: 0,
      answeredCount: 0,
      inaccessibleFrameDetected: hasIframes,
    };
  }

  return {
    formDetected: true,
    fields: winner.fields,
    excludedCount: winner.excludedCount,
    totalDetected: winner.totalDetected,
    includedCount: winner.answeredCount,
    answeredCount: winner.answeredCount,
    formFamilyKey: winner.formFamilyKey || '',
    inaccessibleFrameDetected: false,
    detectedFields: winner.detectedFields,
  };
}
