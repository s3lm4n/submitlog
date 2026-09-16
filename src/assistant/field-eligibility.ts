import { checkSensitiveField } from '../capture/sensitive-filter';
import { extractLabel } from '../capture/label-extractor';
import { extractValue, getFieldType } from '../capture/value-extractor';
import type { FieldType } from '../models/submission';

export interface FieldEligibility {
  eligible: boolean;
  reason?: string;
  label: string;
  fieldType: FieldType;
  currentValue: string;
}

/**
 * Checks if a DOM element is eligible to display the SubmitLog field assistant.
 * Reuses the centralized sensitive filter to guarantee sensitive fields are never touched.
 */
export function checkFieldEligibility(el: HTMLElement): FieldEligibility {
  const isInput = el instanceof HTMLInputElement;
  const isTextArea = el instanceof HTMLTextAreaElement;
  const isSelect = el instanceof HTMLSelectElement;
  const role = el.getAttribute('role')?.toLowerCase();
  const isAriaRole = role === 'textbox' || role === 'combobox' || role === 'listbox';
  const isEditable = el.isContentEditable && !el.parentElement?.isContentEditable;

  if (!isInput && !isTextArea && !isSelect && !isAriaRole && !isEditable) {
    return {
      eligible: false,
      reason: 'Element is not a form control',
      label: '',
      fieldType: 'other',
      currentValue: '',
    };
  }

  if (isInput) {
    const t = el.type.toLowerCase();
    if (t === 'file') {
      return {
        eligible: false,
        reason: 'File inputs are excluded',
        label: '',
        fieldType: 'file',
        currentValue: '',
      };
    }
    if (t === 'submit' || t === 'button' || t === 'reset' || t === 'image' || t === 'hidden') {
      return {
        eligible: false,
        reason: `Input type ${t} is not an editable data field`,
        label: '',
        fieldType: 'other',
        currentValue: '',
      };
    }
  }

  // Central sensitive filter guard
  const sensitiveCheck = checkSensitiveField(el);
  if (sensitiveCheck.isSensitive) {
    return {
      eligible: false,
      reason: sensitiveCheck.reason || 'Sensitive field excluded',
      label: '',
      fieldType: getFieldType(el),
      currentValue: '',
    };
  }

  const doc = el.ownerDocument || document;
  const labelResult = extractLabel(el, doc);
  const fieldType = getFieldType(el);
  const currentValue = extractValue(el);

  return {
    eligible: true,
    label: labelResult.label || el.getAttribute('name') || el.id || 'Field',
    fieldType,
    currentValue,
  };
}
