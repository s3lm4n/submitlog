import type { FieldType } from '../models/submission';
import { getFieldType } from './value-extractor';

export interface DiscoveredField {
  element: HTMLElement;
  fieldType: FieldType;
  groupName?: string;
  groupValues?: Array<{ label: string; value: string; checked: boolean }>;
}

/**
 * Finds form-scoping candidates on a page.
 * Primary candidates are explicit <form> elements.
 * For pages where forms are built without <form> tags, groups by [role="form"] or common container.
 */
export function findFormContainers(doc: Document): Element[] {
  const forms = Array.from(doc.querySelectorAll('form'));
  if (forms.length > 0) {
    return forms;
  }

  // Fallback: look for explicit ARIA form role
  const roleForms = Array.from(doc.querySelectorAll('[role="form"]'));
  if (roleForms.length > 0) {
    return roleForms;
  }

  // If no <form> or role="form", check if main or document contains fields
  const allInputs = doc.querySelectorAll(
    'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]), textarea, select',
  );
  if (allInputs.length >= 2) {
    const main = doc.querySelector('main');
    if (main && main.querySelectorAll('input, textarea, select').length >= 2) {
      return [main];
    }
    return [doc.body || doc.documentElement];
  }

  return [];
}

/**
 * Discovers form fields scoped to a specific container element.
 */
export function discoverFormFields(scope: Element): DiscoveredField[] {
  const elements = Array.from(scope.querySelectorAll<HTMLElement>('input, textarea, select'));
  const discovered: DiscoveredField[] = [];

  const radioGroups: Record<string, HTMLInputElement[]> = {};
  const checkboxGroups: Record<string, HTMLInputElement[]> = {};

  for (const el of elements) {
    if (el instanceof HTMLInputElement) {
      const type = el.type.toLowerCase();
      if (
        type === 'hidden' ||
        type === 'submit' ||
        type === 'button' ||
        type === 'image' ||
        type === 'reset'
      ) {
        continue;
      }

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
