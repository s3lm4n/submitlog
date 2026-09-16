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
 * Traverses a DOM root and open Shadow DOM trees to discover all candidate form controls.
 */
export function collectControlsWithShadowDOM(root: ParentNode): HTMLElement[] {
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
          if (isControlVisible(node)) {
            controls.push(node);
          }
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

  // 3. Semantic application containers (e.g. role="tabpanel", .application-form, etc.)
  const unassignedAfterRoles = allControls.filter((c) => !assigned.has(c));
  if (unassignedAfterRoles.length > 0) {
    const potentialContainers = Array.from(
      doc.querySelectorAll(
        '[role="tabpanel"], [role="region"], fieldset, section, article, div, main',
      ),
    ).filter((el) => {
      if (el === doc.body || el === doc.documentElement) return false;
      const idAndClass = `${el.id} ${el.className}`;
      const role = el.getAttribute('role');
      return (
        role === 'tabpanel' ||
        role === 'region' ||
        el.tagName.toLowerCase() === 'fieldset' ||
        el.tagName.toLowerCase() === 'section' ||
        CONTAINER_APP_PATTERNS.test(idAndClass)
      );
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
        parent.parentElement !== doc.body &&
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
  const radioGroups: Record<string, HTMLInputElement[]> = {};
  const checkboxGroups: Record<string, HTMLInputElement[]> = {};

  for (const el of elements) {
    if (el instanceof HTMLInputElement) {
      const type = el.type.toLowerCase();
      const name = el.name;
      if (type === 'radio' && name) {
        if (!radioGroups[name]) radioGroups[name] = [];
        radioGroups[name].push(el);
        continue;
      }
      if (type === 'checkbox' && name) {
        if (!checkboxGroups[name]) checkboxGroups[name] = [];
        checkboxGroups[name].push(el);
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
        groupValues: radios.map((r) => ({
          label: r.value || 'Radio',
          value: r.value,
          checked: r.checked,
        })),
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
            label: c.value || 'Checkbox',
            value: c.value,
            checked: c.checked,
          })),
        });
      }
    }
  }

  return discovered;
}
