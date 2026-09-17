/**
 * Form quality scoring and candidate-local utility form detection.
 * Determines whether a DOM form or container represents a meaningful submission form
 * (job application, grant, registration, survey, portal, multi-step flow)
 * versus utility UI (search, filters, navigation, isolated toolbar controls).
 */

export interface FormScoreResult {
  score: number;
  isMeaningful: boolean;
  reasons: string[];
}

export const MINIMUM_MEANINGFUL_SCORE = 30;

const SEARCH_PATTERNS = /search|lookup|find|query|filter|nav|toolbar/i;
const APPLICATION_PATTERNS =
  /app|apply|grant|register|signup|contact|proposal|inquiry|feedback|survey|checkout|order|portal|form|intake|submission/i;
const SUBMIT_BUTTON_PATTERNS =
  /submit|apply|send|save.?draft|save|register|complete|finish|continue|next|review|proceed|confirm/i;

/**
 * Checks if a candidate element or form is clearly utility / search UI that should be rejected locally.
 */
export function isUtilityForm(element: Element): boolean {
  // Check explicit ARIA roles
  const role = element.getAttribute('role')?.toLowerCase();
  if (role === 'search' || role === 'navigation' || role === 'toolbar' || role === 'menubar') {
    return true;
  }

  // Check if inside a navigation or toolbar landmark
  if (element.closest('nav, [role="navigation"], [role="toolbar"], [role="search"]')) {
    return true;
  }

  const inputs = Array.from(element.querySelectorAll('input'));
  const textareas = element.querySelectorAll('textarea');
  const idAndClass = `${element.id} ${element.className}`.toLowerCase();

  // Check container id/class for search/filter/toolbar patterns
  if (
    SEARCH_PATTERNS.test(idAndClass) &&
    !APPLICATION_PATTERNS.test(idAndClass) &&
    textareas.length === 0
  ) {
    if (inputs.length <= 4) {
      return true;
    }
  }

  // Check for search or filter input as sole or primary purpose
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

  // Check form action/id/class if HTMLFormElement
  if (element instanceof HTMLFormElement) {
    const action = element.getAttribute('action')?.toLowerCase() || '';
    const name = element.getAttribute('name')?.toLowerCase() || '';
    const combined = `${action} ${name} ${idAndClass}`;
    if (
      SEARCH_PATTERNS.test(combined) &&
      !APPLICATION_PATTERNS.test(combined) &&
      textareas.length === 0
    ) {
      if (inputs.length <= 4) {
        return true;
      }
    }
  }

  return false;
}

const CHAT_OR_COMPOSER_PATTERNS =
  /\b(chat|thread|conversation|composer|prompt-box|prompt-input|message-input|ai-box|chatbot|reply-box|comment-box|chat-input|chatbox|chat-window)\b/i;

const CHAT_ACTION_PATTERNS =
  /^(send|stop|regenerate|ask|attach|mic|new chat|prompt|ask gemini|ask copilot)$/i;

const EDITOR_CONTAINER_PATTERNS =
  /\b(canvas|designer|whiteboard|artboard|document-editor|design-editor|rich-text-editor|prosemirror|monaco-editor|ace_editor|ql-editor|canvas-container|page-container)\b/i;

/**
 * Checks if a candidate element or form is primarily a chat/AI composer, document/design canvas editor,
 * or non-submission context that should NOT be archived as a form draft.
 */
export function isNonSubmissionContext(
  container: Element,
  fields: ScoredFieldCandidate[],
): boolean {
  const idAndClass = `${container.id} ${container.className}`.toLowerCase();

  const hasApplicationFields = fields.some(
    (f) =>
      ['email', 'tel', 'number', 'date'].includes(f.fieldType) ||
      (f.label &&
        /name|email|phone|address|applicant|organization|grant|apply|job|proposal|inquiry|registration/i.test(
          f.label,
        )),
  );

  // 1. Editor / Canvas / Design / Rich-Text Editor surfaces
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
    if (fields.length <= 4) {
      return true;
    }
  }

  // 2. Chat / AI prompt composer / Conversation box
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

  const textInputs = fields.filter(
    (f) => f.isTextarea || f.fieldType === 'text' || f.fieldType === 'other',
  );

  // Chat/AI composer with prompt box and without multi-field application structure
  if (hasChatSemantics && !hasApplicationFields) {
    if (fields.length <= 3) {
      return true;
    }
  }

  // Single prompt input + chat action (Send/Ask/Stop/Regenerate) without application structure
  if (textInputs.length === 1 && fields.length <= 2 && hasChatAction && !hasApplicationFields) {
    return true;
  }

  return false;
}

export interface ScoredFieldCandidate {
  fieldType: string;
  hasValue: boolean;
  isTextarea: boolean;
  hasLabel: boolean;
  label?: string;
  isRequired?: boolean;
}

/**
 * Calculates a structural quality score for a form candidate based on its controls,
 * container semantics, and workflow buttons.
 *
 * Crucial Principle: Form detection operates on structural evidence of safe meaningful controls,
 * regardless of whether answers have been filled in yet.
 */
export function scoreFormCandidate(
  container: Element,
  fields: ScoredFieldCandidate[],
): FormScoreResult {
  const reasons: string[] = [];

  // Reject utility forms or non-submission contexts immediately
  if (isUtilityForm(container) || isNonSubmissionContext(container, fields)) {
    return {
      score: -999,
      isMeaningful: false,
      reasons: ['Detected as search, navigation, chat composer, or editor UI'],
    };
  }

  if (fields.length === 0) {
    return {
      score: 0,
      isMeaningful: false,
      reasons: ['Contains zero meaningful capturable fields'],
    };
  }

  let score = 0;
  let textareaCount = 0;
  let filledCount = 0;
  let requiredCount = 0;
  const labelsSeen = new Set<string>();

  for (const f of fields) {
    if (f.isTextarea) {
      textareaCount++;
      score += 25;
      reasons.push('Textarea input (+25)');
    } else if (['email', 'tel', 'url', 'number', 'date'].includes(f.fieldType)) {
      score += 15;
      reasons.push(`Application field type: ${f.fieldType} (+15)`);
    } else if (f.fieldType === 'radio' || f.fieldType === 'checkbox') {
      score += 15;
      reasons.push(`Group choice field: ${f.fieldType} (+15)`);
    } else if (f.fieldType === 'select') {
      score += 10;
      reasons.push('Select dropdown (+10)');
    } else {
      score += 10;
      reasons.push(`Standard input: ${f.fieldType} (+10)`);
    }

    if (f.hasValue) {
      filledCount++;
    }

    if (f.isRequired) {
      requiredCount++;
    }

    if (f.label && f.label.trim()) {
      labelsSeen.add(f.label.trim().toLowerCase());
    }
  }

  // Multi-field structural scale bonuses
  if (fields.length >= 2) {
    score += 15;
    reasons.push('Contains 2+ fields (+15)');
  }
  if (fields.length >= 4) {
    score += 20;
    reasons.push('Contains 4+ fields (+20)');
  }
  if (fields.length >= 8) {
    score += 25;
    reasons.push('Contains 8+ fields (+25)');
  }
  if (textareaCount >= 2) {
    score += 30;
    reasons.push('Contains multiple textareas/long-answers (+30)');
  }
  if (labelsSeen.size >= 3) {
    score += 15;
    reasons.push('Contains multiple distinct labeled questions (+15)');
  }
  if (requiredCount >= 1) {
    const reqBonus = Math.min(requiredCount * 5, 20);
    score += reqBonus;
    reasons.push(`Contains required fields (+${reqBonus})`);
  }

  // Container structural / semantic signals
  const tag = container.tagName.toLowerCase();
  const role = container.getAttribute('role')?.toLowerCase();

  if (tag === 'form') {
    score += 15;
    reasons.push('Explicit <form> tag (+15)');
  }
  if (role === 'form') {
    score += 15;
    reasons.push('Explicit role="form" (+15)');
  }
  if (container.querySelector('fieldset legend')) {
    score += 15;
    reasons.push('Contains fieldset with legend (+15)');
  }

  const idAndClass = `${container.id} ${container.className}`.toLowerCase();
  if (APPLICATION_PATTERNS.test(idAndClass)) {
    score += 20;
    reasons.push('Container matches application/form pattern (+20)');
  }

  // Multi-step / tabbed application structure
  if (
    container.querySelector('[role="tabpanel"], [role="tablist"], .step, .tab-pane, .form-step') ||
    role === 'tabpanel' ||
    /page\s+\d+\s*[-of/]+\s*\d+/i.test(container.textContent || '')
  ) {
    score += 15;
    reasons.push('Multi-step or tabbed application structure (+15)');
  }

  // Structured question list structure (e.g. div-based question cards or role="list")
  if (
    role === 'list' ||
    container.querySelectorAll('[role="listitem"], .question-card').length >= 2
  ) {
    score += 15;
    reasons.push('Structured question list structure (+15)');
  }

  if (
    container instanceof HTMLFormElement &&
    container.method &&
    container.method.toLowerCase() === 'post'
  ) {
    score += 10;
    reasons.push('Form uses POST method (+10)');
  }

  // Check for submission / workflow buttons
  const buttons = Array.from(
    container.querySelectorAll(
      'button, input[type="submit"], input[type="button"], a.btn, div[role="button"]',
    ),
  );
  if (container.id && container.ownerDocument) {
    const associatedBtns = Array.from(
      container.ownerDocument.querySelectorAll(
        `button[form="${CSS.escape(container.id)}"], input[form="${CSS.escape(container.id)}"]`,
      ),
    );
    buttons.push(...(associatedBtns as HTMLElement[]));
  }

  const hasWorkflowBtn = buttons.some((btn) => {
    const text = (btn.textContent || (btn as HTMLInputElement).value || '').trim();
    return SUBMIT_BUTTON_PATTERNS.test(text);
  });

  if (hasWorkflowBtn) {
    score += 25;
    reasons.push('Contains submission/workflow button (+25)');
  }

  // Minor bonus for filled answers (bonus only, never a prerequisite)
  if (filledCount > 0) {
    const valueBonus = Math.min(filledCount * 3, 15);
    score += valueBonus;
    reasons.push(`User answers present (+${valueBonus})`);
  }

  // Penalties for non-application candidates
  if (fields.length < 2 && textareaCount === 0) {
    score -= 50;
    reasons.push('Fewer than 2 fields without textareas (-50)');
  } else if (
    fields.length <= 2 &&
    textareaCount === 0 &&
    !hasWorkflowBtn &&
    !APPLICATION_PATTERNS.test(idAndClass)
  ) {
    score -= 40;
    reasons.push('Small candidate lacking workflow button or application context (-40)');
  }

  const isMeaningful = score >= MINIMUM_MEANINGFUL_SCORE && fields.length >= 1;

  return {
    score,
    isMeaningful,
    reasons,
  };
}
