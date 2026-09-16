import type { FieldType } from '../models/submission';
import { extractLabel } from './label-extractor';

export function getFieldType(element: HTMLElement): FieldType {
  const role = element.getAttribute('role')?.toLowerCase();
  if (role === 'radio') return 'radio';
  if (role === 'checkbox') return 'checkbox';
  if (role === 'textbox') return 'text';
  if (role === 'combobox' || role === 'listbox') return 'select';

  if (element instanceof HTMLTextAreaElement) return 'textarea';
  if (element instanceof HTMLSelectElement) return 'select';
  if (element instanceof HTMLInputElement) {
    const type = element.type.toLowerCase();
    switch (type) {
      case 'text':
      case 'email':
      case 'tel':
      case 'url':
      case 'number':
      case 'date':
      case 'checkbox':
      case 'radio':
      case 'file':
        return type as FieldType;
      default:
        return 'other';
    }
  }
  return 'other';
}

export function extractValue(element: HTMLElement): string {
  let value = '';

  const role = element.getAttribute('role')?.toLowerCase();
  if (role === 'radio') {
    const isChecked =
      element.getAttribute('aria-checked') === 'true' ||
      element.classList.contains('checked') ||
      element.classList.contains('is-checked');
    if (isChecked) {
      value =
        element.getAttribute('aria-label') ||
        element.getAttribute('data-value') ||
        element.textContent?.trim() ||
        'Selected';
    } else {
      value = '';
    }
    return value.replace(/\s+/g, ' ').trim();
  }

  if (role === 'checkbox') {
    const isChecked =
      element.getAttribute('aria-checked') === 'true' ||
      element.classList.contains('checked') ||
      element.classList.contains('is-checked');
    return isChecked ? 'Checked' : '';
  }

  if (role === 'textbox') {
    value =
      element.textContent ||
      (element as HTMLElement).innerText ||
      element.getAttribute('value') ||
      '';
    return value.replace(/\s+/g, ' ').trim();
  }

  if (element instanceof HTMLInputElement) {
    const type = element.type.toLowerCase();
    if (type === 'checkbox') {
      value = element.checked ? 'Checked' : '';
    } else if (type === 'radio') {
      if (element.checked) {
        const labelInfo = extractLabel(element, element.ownerDocument);
        value =
          labelInfo.source !== 'unknown' &&
          labelInfo.source !== 'name-fallback' &&
          labelInfo.source !== 'id-fallback'
            ? labelInfo.label
            : element.value || 'Selected';
      } else {
        value = '';
      }
    } else if (type === 'file') {
      if (element.files && element.files.length > 0) {
        const fileNames = Array.from(element.files)
          .map((f) => f.name)
          .join(', ');
        value = `${fileNames} selected`;
      } else {
        // Empty file input must never return "No file selected"
        value = '';
      }
    } else {
      value = element.value;
    }
  } else if (element instanceof HTMLTextAreaElement) {
    value = element.value;
  } else if (element instanceof HTMLSelectElement) {
    const selectedOptions = Array.from(element.selectedOptions);
    if (selectedOptions.length === 1) {
      const opt = selectedOptions[0];
      if (opt) {
        // If the option has an empty value or is placeholder text, treat as empty
        if (!opt.value && /select|choose|none|^--/i.test(opt.text)) {
          value = '';
        } else {
          value = opt.text;
        }
      }
    } else {
      value = selectedOptions.map((opt) => opt.text).join(', ');
    }
  }

  return value.replace(/\s+/g, ' ').trim();
}
