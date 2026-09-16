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

export interface InjectedScanResult {
  formDetected: boolean;
  totalFields: number;
  answeredCount: number;
  score: number;
  inaccessibleFrameDetected?: boolean;
}

export interface InjectedCaptureResult {
  formDetected: boolean;
  fields: InjectedCapturedField[];
  excludedCount: number;
  totalDetected: number;
  includedCount: number;
  answeredCount: number;
  inaccessibleFrameDetected?: boolean;
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
  ];

  const SENSITIVE_PATTERN =
    /password|passwd|pwd|otp|totp|mfa|cvv|cvc|cardnumber|card-number|card_number|cc-num|cc_num|secret|token|auth_token|ssn|social.?security|pin_code/i;

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
        if (tag === 'input' || tag === 'textarea' || tag === 'select') {
          const type = tag === 'input' ? (node as HTMLInputElement).type.toLowerCase() : '';
          if (
            type !== 'hidden' &&
            type !== 'submit' &&
            type !== 'button' &&
            type !== 'image' &&
            type !== 'reset'
          ) {
            if (isVisible(node)) controls.push(node);
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

  function getLabelText(el: HTMLElement): string {
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l?.textContent?.trim()) return l.textContent.trim();
    }

    if (el instanceof HTMLInputElement && el.type === 'radio') {
      const group = el.closest('[role="group"], [role="radiogroup"]');
      if (group) {
        const gLabel = group.getAttribute('aria-label');
        if (gLabel?.trim()) return gLabel.trim();
        const gLabelledby = group.getAttribute('aria-labelledby');
        if (gLabelledby) {
          const parts = gLabelledby
            .split(/\s+/)
            .map((refId) => document.getElementById(refId)?.textContent?.trim())
            .filter(Boolean);
          if (parts.length > 0) return parts.join(' ');
        }
      }
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

    const questionCard = el.closest(
      '[role="listitem"], .form-group, .question, .field, .form-row, .field-wrapper',
    );
    if (questionCard) {
      const heading = questionCard.querySelector<HTMLElement>(
        'h1, h2, h3, h4, h5, h6, [role="heading"], .question-title, .field-label',
      );
      if (heading?.textContent?.trim() && !heading.contains(el)) {
        return heading.textContent.trim();
      }
    }

    const placeholder = el.getAttribute('placeholder');
    if (placeholder?.trim()) return placeholder.trim();

    const name = el.getAttribute('name');
    if (name?.trim()) return name.trim();

    const id = el.getAttribute('id');
    if (id?.trim()) return id.trim();

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

  // Grouping 3: Semantic SPA containers or fieldsets
  const unassignedAfterRoles = allControls.filter((c) => !assigned.has(c));
  if (unassignedAfterRoles.length > 0) {
    const containers = Array.from(
      document.querySelectorAll(
        '[role="tabpanel"], [role="region"], fieldset, section, article, div, main',
      ),
    ).filter((el) => {
      if (el === document.body || el === document.documentElement) return false;
      const idAndClass = `${el.id} ${el.className}`;
      const role = el.getAttribute('role');
      return (
        role === 'tabpanel' ||
        role === 'region' ||
        el.tagName.toLowerCase() === 'fieldset' ||
        APPLICATION_PATTERNS.test(idAndClass)
      );
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
        parent.querySelectorAll('input, textarea, select').length <= 20
      ) {
        if (
          parent.tagName.toLowerCase() === 'div' ||
          parent.tagName.toLowerCase() === 'section' ||
          parent.tagName.toLowerCase() === 'article' ||
          parent.tagName.toLowerCase() === 'fieldset'
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
    if (isUtility(container)) return;

    let totalMeaningful = 0;
    let answered = 0;
    let score = 0;
    let textareaCount = 0;
    const seenRadioGroups = new Set<string>();
    const labelsSeen = new Set<string>();

    for (const el of elements) {
      if (isSensitive(el)) {
        totalMeaningful++;
        continue;
      }

      const label = getLabelText(el);
      if (!label) continue;

      if (el instanceof HTMLInputElement && el.type === 'radio' && el.name) {
        if (seenRadioGroups.has(el.name)) continue;
        seenRadioGroups.add(el.name);
        totalMeaningful++;
        score += 15;
        labelsSeen.add(label.toLowerCase());

        const checked = container.querySelector(
          `input[type="radio"][name="${CSS.escape(el.name)}"]:checked`,
        );
        if (checked) answered++;
        continue;
      }

      totalMeaningful++;
      labelsSeen.add(label.toLowerCase());

      const val = getFieldValue(el);
      if (val) answered++;

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
    inaccessibleFrameDetected: false,
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
  ];

  const SENSITIVE_PATTERN =
    /password|passwd|pwd|otp|totp|mfa|cvv|cvc|cardnumber|card-number|card_number|cc-num|cc_num|secret|token|auth_token|ssn|social.?security|pin_code/i;

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
        if (tag === 'input' || tag === 'textarea' || tag === 'select') {
          const type = tag === 'input' ? (node as HTMLInputElement).type.toLowerCase() : '';
          if (
            type !== 'hidden' &&
            type !== 'submit' &&
            type !== 'button' &&
            type !== 'image' &&
            type !== 'reset'
          ) {
            if (isVisible(node)) controls.push(node);
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

  function getLabelText(el: HTMLElement): string {
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l?.textContent?.trim()) {
        return l.textContent.trim();
      }
    }

    if (el instanceof HTMLInputElement && el.type === 'radio') {
      const group = el.closest('[role="group"], [role="radiogroup"]');
      if (group) {
        const gLabel = group.getAttribute('aria-label');
        if (gLabel?.trim()) return gLabel.trim();
        const gLabelledby = group.getAttribute('aria-labelledby');
        if (gLabelledby) {
          const parts = gLabelledby
            .split(/\s+/)
            .map((refId) => document.getElementById(refId)?.textContent?.trim())
            .filter(Boolean);
          if (parts.length > 0) return parts.join(' ');
        }
      }
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
      if (parts.length > 0) {
        return parts.join(' ');
      }
    }
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel?.trim()) {
      return ariaLabel.trim();
    }

    const fieldset = el.closest('fieldset');
    if (fieldset) {
      const leg = fieldset.querySelector('legend');
      if (leg?.textContent?.trim()) {
        return leg.textContent.trim();
      }
    }

    const questionCard = el.closest(
      '[role="listitem"], .form-group, .question, .field, .form-row, .field-wrapper',
    );
    if (questionCard) {
      const heading = questionCard.querySelector<HTMLElement>(
        'h1, h2, h3, h4, h5, h6, [role="heading"], .question-title, .field-label',
      );
      if (heading?.textContent?.trim() && !heading.contains(el)) {
        return heading.textContent.trim();
      }
    }

    const placeholder = el.getAttribute('placeholder');
    if (placeholder?.trim()) {
      return placeholder.trim();
    }

    const name = el.getAttribute('name');
    if (name?.trim()) {
      return name.trim();
    }

    const id = el.getAttribute('id');
    if (id?.trim()) {
      return id.trim();
    }

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

  // Grouping 3: Semantic containers
  const unassignedAfterRoles = allControls.filter((c) => !assigned.has(c));
  if (unassignedAfterRoles.length > 0) {
    const containers = Array.from(
      document.querySelectorAll(
        '[role="tabpanel"], [role="region"], fieldset, section, article, div, main',
      ),
    ).filter((el) => {
      if (el === document.body || el === document.documentElement) return false;
      const idAndClass = `${el.id} ${el.className}`;
      const role = el.getAttribute('role');
      return (
        role === 'tabpanel' ||
        role === 'region' ||
        el.tagName.toLowerCase() === 'fieldset' ||
        APPLICATION_PATTERNS.test(idAndClass)
      );
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
        parent.querySelectorAll('input, textarea, select').length <= 20
      ) {
        if (
          parent.tagName.toLowerCase() === 'div' ||
          parent.tagName.toLowerCase() === 'section' ||
          parent.tagName.toLowerCase() === 'article' ||
          parent.tagName.toLowerCase() === 'fieldset'
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
    if (isUtility(container)) return;

    const fields: InjectedCapturedField[] = [];
    let excludedCount = 0;
    let totalMeaningful = 0;
    let answered = 0;
    let score = 0;
    let textareaCount = 0;
    const seenRadioGroups = new Set<string>();
    const labelsSeen = new Set<string>();

    for (const el of elements) {
      if (isSensitive(el)) {
        excludedCount++;
        totalMeaningful++;
        const labelInfo = getLabelText(el);
        const fType =
          el instanceof HTMLTextAreaElement
            ? 'textarea'
            : el instanceof HTMLSelectElement
              ? 'select'
              : (el as HTMLInputElement).type || 'text';
        fields.push({
          id: crypto.randomUUID(),
          label: labelInfo || 'Sensitive Field',
          value: '',
          fieldType: fType,
          labelSource: 'unknown',
          excluded: true,
          excludeReason: 'Sensitive field excluded for privacy',
        });
        continue;
      }

      const labelInfo = getLabelText(el);
      if (!labelInfo) continue; // Unknown Field Policy: exclude unlabeled controls

      totalMeaningful++;
      labelsSeen.add(labelInfo.toLowerCase());

      // Radio group consolidation
      if (el instanceof HTMLInputElement && el.type === 'radio' && el.name) {
        if (seenRadioGroups.has(el.name)) continue;
        seenRadioGroups.add(el.name);

        const radios = container.querySelectorAll<HTMLInputElement>(
          `input[type="radio"][name="${CSS.escape(el.name)}"]`,
        );
        const checked = Array.from(radios).find((r) => r.checked);
        if (checked) {
          answered++;
          const checkedLabel = getLabelText(checked);
          const radioVal = checkedLabel || checked.value || 'Selected';
          fields.push({
            id: crypto.randomUUID(),
            label: labelInfo,
            value: radioVal,
            fieldType: 'radio',
            labelSource: 'role-label',
            excluded: false,
          });
        }
        score += 15;
        continue;
      }

      // Checkbox group consolidation if multiple with same name
      if (el instanceof HTMLInputElement && el.type === 'checkbox' && el.name) {
        const sameName = container.querySelectorAll<HTMLInputElement>(
          `input[type="checkbox"][name="${CSS.escape(el.name)}"]`,
        );
        if (sameName.length > 1) {
          if (fields.some((f) => f.label === labelInfo)) continue;
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

      const val = getFieldValue(el);
      if (val) {
        answered++;
        const fType =
          el instanceof HTMLTextAreaElement
            ? 'textarea'
            : el instanceof HTMLSelectElement
              ? 'select'
              : (el as HTMLInputElement).type || 'text';

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
    inaccessibleFrameDetected: false,
  };
}
