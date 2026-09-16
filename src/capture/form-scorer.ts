/**
 * Form quality scoring and utility form detection.
 * Determines whether a DOM form or container represents a meaningful submission form
 * (job application, grant, registration, survey, etc.) versus utility UI (search, filters, navigation).
 */

export interface FormScoreResult {
  score: number;
  isMeaningful: boolean;
  reasons: string[];
}

const MINIMUM_MEANINGFUL_SCORE = 30;

const SEARCH_PATTERNS = /search|lookup|find|query|filter|nav|toolbar/i;
const APPLICATION_PATTERNS =
  /app|apply|grant|register|signup|contact|proposal|inquiry|feedback|survey|checkout|order/i;
const SUBMIT_BUTTON_PATTERNS = /submit|apply|send|save|register|complete|finish|continue|next/i;

/**
 * Checks if an element or form is clearly utility / search UI that should be rejected.
 */
export function isUtilityForm(element: Element): boolean {
  // Check explicit ARIA roles
  const role = element.getAttribute('role')?.toLowerCase();
  if (role === 'search' || role === 'navigation' || role === 'toolbar' || role === 'menubar') {
    return true;
  }

  // Check if inside a navigation or header landmark
  if (element.closest('nav, [role="navigation"], [role="toolbar"], [role="search"]')) {
    return true;
  }

  // Check for search input as sole or primary purpose
  const inputs = Array.from(element.querySelectorAll('input'));
  const hasSearchInput = inputs.some(
    (inp) =>
      inp.type === 'search' ||
      inp.name === 'q' ||
      inp.name === 'query' ||
      inp.name === 'search' ||
      inp.getAttribute('aria-label')?.toLowerCase().includes('search'),
  );

  // If search input exists and total inputs <= 2 without textareas, it is utility search
  const textareas = element.querySelectorAll('textarea');
  if (hasSearchInput && inputs.length <= 3 && textareas.length === 0) {
    return true;
  }

  // Check form action/id/class
  if (element instanceof HTMLFormElement) {
    const action = element.getAttribute('action')?.toLowerCase() || '';
    const name = element.getAttribute('name')?.toLowerCase() || '';
    const id = element.getAttribute('id')?.toLowerCase() || '';
    const className = typeof element.className === 'string' ? element.className.toLowerCase() : '';

    const combined = `${action} ${name} ${id} ${className}`;
    if (
      SEARCH_PATTERNS.test(combined) &&
      !APPLICATION_PATTERNS.test(combined) &&
      textareas.length === 0
    ) {
      if (inputs.length <= 3) {
        return true;
      }
    }
  }

  return false;
}

export interface ScoredFieldCandidate {
  fieldType: string;
  hasValue: boolean;
  isTextarea: boolean;
  hasLabel: boolean;
}

/**
 * Calculates a quality score for a form candidate based on its structural characteristics and fields.
 */
export function scoreFormCandidate(
  container: Element,
  fields: ScoredFieldCandidate[],
): FormScoreResult {
  const reasons: string[] = [];

  // Reject utility forms immediately
  if (isUtilityForm(container)) {
    return {
      score: -999,
      isMeaningful: false,
      reasons: ['Detected as search, navigation, or utility UI'],
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

  // Score individual fields
  let textareaCount = 0;
  let filledCount = 0;

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
  }

  // Multi-field bonuses
  if (fields.length >= 3) {
    score += 20;
    reasons.push('Contains 3+ fields (+20)');
  }
  if (fields.length >= 6) {
    score += 25;
    reasons.push('Contains 6+ fields (+25)');
  }
  if (textareaCount >= 2) {
    score += 30;
    reasons.push('Contains multiple textareas/long-answers (+30)');
  }

  // Container semantic indicators
  if (container instanceof HTMLFormElement) {
    const idAndClass = `${container.id} ${container.className}`.toLowerCase();
    if (APPLICATION_PATTERNS.test(idAndClass)) {
      score += 25;
      reasons.push('Container matches application/grant/form pattern (+25)');
    }

    if (container.method && container.method.toLowerCase() === 'post') {
      score += 10;
      reasons.push('Form uses POST method (+10)');
    }

    // Check for submit button
    const submitBtn = container.querySelector(
      'button[type="submit"], input[type="submit"], button:not([type])',
    );
    if (submitBtn) {
      const btnText = (submitBtn.textContent || (submitBtn as HTMLInputElement).value || '').trim();
      if (SUBMIT_BUTTON_PATTERNS.test(btnText)) {
        score += 25;
        reasons.push(`Submit button matches submission pattern: "${btnText}" (+25)`);
      }
    }
  }

  // Penalties
  if (fields.length < 2 && textareaCount === 0) {
    score -= 40;
    reasons.push('Fewer than 2 fields without textareas (-40)');
  }

  if (filledCount === 0 && fields.length <= 2) {
    score -= 30;
    reasons.push('No filled user values in small form (-30)');
  }

  const isMeaningful = score >= MINIMUM_MEANINGFUL_SCORE && fields.length >= 1;

  return {
    score,
    isMeaningful,
    reasons,
  };
}
