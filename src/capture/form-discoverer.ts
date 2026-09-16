import type { FieldType } from '../models/submission';
import { getFieldType } from './value-extractor';

export interface DiscoveredField {
  element: HTMLElement;
  fieldType: FieldType;
  groupName?: string;
  groupValues?: Array<{ label: string; value: string; checked: boolean }>;
}

export interface FormCandidate {
  container: Element;
  type: 'form' | 'role-form' | 'fieldset' | 'cluster' | 'shadow';
  elements: HTMLElement[];
}

/**
 * Determines whether a form control is currently visible (excluding inactive tabs/steps).
 */
export function isControlVisible(el: HTMLElement): boolean {
  if (el.hasAttribute('hidden')) return false;
  if (el.getAttribute('aria-hidden') === 'true') return false;
  if (el.style.display === 'none' || el.style.visibility === 'hidden') return false;

  // Check for hidden ancestor
  const hiddenAncestor = el.closest(
    '[hidden], [aria-hidden="true"], [style*="display: none"], [style*="display:none"], [style*="visibility: hidden"], [style*="visibility:hidden"]',
  );
  if (hiddenAncestor) return false;

  if (typeof window !== 'undefined' && window.getComputedStyle) {
    try {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
    } catch {
      // Ignore if computed style cannot be read
    }
  }

  return true;
}

/**
 * Determines whether a form control or role-based control is candidate form element.
 */
export function isFormControlElement(node: Node): HTMLElement | null {
  if (!(node instanceof HTMLElement)) return null;
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
      return node;
    }
    return null;
  }

  const role = node.getAttribute('role')?.toLowerCase();
  if (
    role === 'radio' ||
    role === 'checkbox' ||
    role === 'textbox' ||
    role === 'combobox' ||
    role === 'listbox'
  ) {
    return node;
  }

  if (node.isContentEditable && !node.parentElement?.isContentEditable) {
    return node;
  }

  return null;
}

/**
 * Traverses a DOM root and open Shadow DOM trees to discover all candidate form controls.
 */
export function collectControlsWithShadowDOM(root: ParentNode): HTMLElement[] {
  const controls: HTMLElement[] = [];

  function walk(node: Node) {
    if (node instanceof HTMLElement) {
      const ctrl = isFormControlElement(node);
      if (ctrl && isControlVisible(ctrl)) {
        controls.push(ctrl);
        const role = ctrl.getAttribute('role')?.toLowerCase();
        if (
          ctrl instanceof HTMLInputElement ||
          ctrl instanceof HTMLSelectElement ||
          ctrl instanceof HTMLTextAreaElement ||
          role === 'radio' ||
          role === 'checkbox'
        ) {
          if (node.shadowRoot) walk(node.shadowRoot);
          return;
        }
      }
      // Recursively traverse open shadow roots
      if (node.shadowRoot) {
        walk(node.shadowRoot);
      }
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

const CONTAINER_APP_PATTERNS =
  /app|apply|grant|register|signup|contact|proposal|inquiry|feedback|survey|checkout|order|portal|form|step|tab-pane|content/i;
const SUBMIT_BUTTON_PATTERNS =
  /submit|apply|send|save.?draft|save|register|complete|finish|continue|next|review|proceed|confirm/i;

/**
 * Discovers form candidates across real-world structures:
 * - Native <form> elements and controls associated via [form] attribute
 * - ARIA [role="form"]
 * - Fieldset groups
 * - Semantic SPA / AJAX application containers
 * - Proximity clusters (without merging independent sections)
 */
export function findFormCandidates(doc: Document): FormCandidate[] {
  const root = doc.body || doc.documentElement;
  if (!root) return [];

  const allControls = collectControlsWithShadowDOM(root);
  if (allControls.length === 0) return [];

  const assigned = new Set<HTMLElement>();
  const candidates: FormCandidate[] = [];

  // 1. Native <form> elements + form-associated controls
  const nativeForms = Array.from(doc.querySelectorAll('form'));
  for (const form of nativeForms) {
    const inside = allControls.filter((c) => form.contains(c));
    const associated = form.id
      ? allControls.filter(
          (c) =>
            !form.contains(c) &&
            (c.getAttribute('form') === form.id || (c as HTMLInputElement).form === form),
        )
      : [];

    const formControls = Array.from(new Set([...inside, ...associated]));
    if (formControls.length > 0) {
      candidates.push({
        container: form,
        type: 'form',
        elements: formControls,
      });
      formControls.forEach((c) => assigned.add(c));
    }
  }

  // 2. [role="form"] containers
  const unassignedAfterForms = allControls.filter((c) => !assigned.has(c));
  const roleForms = Array.from(doc.querySelectorAll('[role="form"]'));
  for (const roleForm of roleForms) {
    const matching = unassignedAfterForms.filter((c) => !assigned.has(c) && roleForm.contains(c));
    if (matching.length > 0) {
      candidates.push({
        container: roleForm,
        type: 'role-form',
        elements: matching,
      });
      matching.forEach((c) => assigned.add(c));
    }
  }

  // 3. Semantic application containers & Question card lists (e.g. role="tabpanel", role="list", .application-form, etc.)
  const unassignedAfterRoles = allControls.filter((c) => !assigned.has(c));
  if (unassignedAfterRoles.length > 0) {
    const potentialContainers = Array.from(
      doc.querySelectorAll(
        '[role="tabpanel"], [role="region"], [role="list"], fieldset, section, article, div, main',
      ),
    ).filter((el) => {
      if (el === doc.body || el === doc.documentElement) return false;
      const idAndClass = `${el.id} ${el.className}`.toLowerCase();
      const role = el.getAttribute('role')?.toLowerCase();

      // Check if container contains 2+ question cards
      const questionCardCount = el.querySelectorAll(
        '[role="listitem"], .question-card, .question, .form-group, .field-wrapper',
      ).length;

      // Check for workflow buttons inside this container
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
        CONTAINER_APP_PATTERNS.test(idAndClass) ||
        (questionCardCount >= 2 && containsControls) ||
        (hasWorkflowBtn && containsControls) ||
        (hasStepIndicator && containsControls)
      );
    });

    // Prioritize containers that have workflow buttons and more controls
    potentialContainers.sort((a, b) => {
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

    for (const container of potentialContainers) {
      const contained = unassignedAfterRoles.filter(
        (c) => !assigned.has(c) && container.contains(c),
      );
      if (
        contained.length >= 2 ||
        (contained.length >= 1 && contained.some((c) => c instanceof HTMLTextAreaElement))
      ) {
        candidates.push({
          container,
          type: container.tagName.toLowerCase() === 'fieldset' ? 'fieldset' : 'cluster',
          elements: contained,
        });
        contained.forEach((c) => assigned.add(c));
      }
    }
  }

  // 4. Proximity clustering for remaining unassigned controls
  const remaining = allControls.filter((c) => !assigned.has(c));
  if (remaining.length > 0) {
    // Group remaining controls by their nearest common card/section/parent
    const clusters = new Map<Element, HTMLElement[]>();

    for (const ctrl of remaining) {
      // Find nearest ancestor block that isn't body, html, or main
      let parent: Element | null = ctrl.parentElement;
      while (
        parent &&
        parent !== doc.body &&
        parent !== doc.documentElement &&
        parent.tagName.toLowerCase() !== 'main' &&
        parent.parentElement &&
        parent.parentElement !== doc.body
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

      const clusterContainer = parent || ctrl.parentElement || doc.body;
      const list = clusters.get(clusterContainer) || [];
      list.push(ctrl);
      clusters.set(clusterContainer, list);
    }

    for (const [container, clusterControls] of clusters.entries()) {
      candidates.push({
        container,
        type: 'cluster',
        elements: clusterControls,
      });
      clusterControls.forEach((c) => assigned.add(c));
    }
  }

  return candidates;
}

/**
 * Backwards compatibility helper returning Element[] containers.
 */
export function findFormContainers(doc: Document): Element[] {
  return findFormCandidates(doc).map((c) => c.container);
}

/**
 * Discovers and groups form fields for a candidate.
 */
export function discoverFormFields(candidate: FormCandidate | Element): DiscoveredField[] {
  let elements: HTMLElement[];
  if ('elements' in candidate && Array.isArray(candidate.elements)) {
    elements = candidate.elements;
  } else {
    elements = collectControlsWithShadowDOM(candidate as Element);
  }

  const discovered: DiscoveredField[] = [];
  const radioGroups: Record<string, HTMLElement[]> = {};
  const checkboxGroups: Record<string, HTMLElement[]> = {};

  for (const el of elements) {
    const role = el.getAttribute('role')?.toLowerCase();
    const isRadio =
      (el instanceof HTMLInputElement && el.type.toLowerCase() === 'radio') || role === 'radio';
    const isCheckbox =
      (el instanceof HTMLInputElement && el.type.toLowerCase() === 'checkbox') ||
      role === 'checkbox';

    if (isRadio) {
      let groupKey = el.getAttribute('name') || '';
      if (!groupKey) {
        const groupContainer = el.closest('[role="radiogroup"], [role="group"]');
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
      let groupList = radioGroups[groupKey];
      if (!groupList) {
        groupList = [];
        radioGroups[groupKey] = groupList;
      }
      groupList.push(el);
      continue;
    }

    if (isCheckbox) {
      const name = el.getAttribute('name');
      if (name) {
        let cbList = checkboxGroups[name];
        if (!cbList) {
          cbList = [];
          checkboxGroups[name] = cbList;
        }
        cbList.push(el);
        continue;
      }
    }

    discovered.push({
      element: el,
      fieldType: getFieldType(el),
    });
  }

  for (const [name, radios] of Object.entries(radioGroups)) {
    const first = radios[0];
    if (first) {
      discovered.push({
        element: first,
        fieldType: 'radio',
        groupName: name,
        groupValues: radios.map((r) => {
          const isChecked =
            r instanceof HTMLInputElement
              ? r.checked
              : r.getAttribute('aria-checked') === 'true' ||
                r.classList.contains('checked') ||
                r.classList.contains('is-checked');
          const val =
            r.getAttribute('data-value') ||
            r.getAttribute('aria-label') ||
            (r instanceof HTMLInputElement ? r.value : r.textContent?.trim()) ||
            'Radio';
          return {
            label: val,
            value: val,
            checked: isChecked,
          };
        }),
      });
    }
  }

  for (const [name, checkboxes] of Object.entries(checkboxGroups)) {
    const first = checkboxes[0];
    if (first) {
      if (checkboxes.length === 1) {
        discovered.push({
          element: first,
          fieldType: 'checkbox',
        });
      } else {
        discovered.push({
          element: first,
          fieldType: 'checkbox',
          groupName: name,
          groupValues: checkboxes.map((c) => ({
            label: (c instanceof HTMLInputElement ? c.value : c.textContent?.trim()) || 'Checkbox',
            value: (c instanceof HTMLInputElement ? c.value : c.textContent?.trim()) || 'Checkbox',
            checked:
              c instanceof HTMLInputElement ? c.checked : c.getAttribute('aria-checked') === 'true',
          })),
        });
      }
    }
  }

  return discovered;
}
