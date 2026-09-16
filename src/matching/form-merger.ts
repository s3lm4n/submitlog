import type { CapturedField, Submission } from '../models/submission';
import { findFieldMatch } from './field-matcher';

export type FieldDiffStatus =
  'unchanged' | 'changed' | 'newly_added' | 'blank_preserved' | 'missing_preserved';

export interface FieldDiff {
  id: string;
  label: string;
  fieldType: CapturedField['fieldType'];
  status: FieldDiffStatus;
  oldValue?: string;
  newValue?: string;
  finalValue: string;
}

export interface MergePreview {
  changedCount: number;
  newCount: number;
  unchangedCount: number;
  blankPreservedCount: number;
  missingPreservedCount: number;
  diffs: FieldDiff[];
  mergedFields: CapturedField[];
}

/**
 * Performs a non-destructive merge of a current form capture into an existing saved submission.
 * Preserves historical values when current fields are blank or missing.
 * Excludes sensitive fields completely.
 */
export function mergeSubmissions(
  savedSubmission: Submission,
  currentFields: CapturedField[],
): MergePreview {
  const diffs: FieldDiff[] = [];
  const mergedFields: CapturedField[] = [];

  // Filter out any sensitive fields from both sides just in case
  const safeSaved = savedSubmission.fields.filter((f) => !f.excluded);
  const safeCurrent = currentFields.filter((f) => !f.excluded);

  // Track which saved fields have been processed
  const processedSavedIds = new Set<string>();

  // Process all current fields
  for (const currentField of safeCurrent) {
    const savedMatch = findFieldMatch(currentField, safeSaved);

    if (savedMatch) {
      processedSavedIds.add(savedMatch.id);
      const currentVal = (currentField.value || '').trim();
      const savedVal = (savedMatch.value || '').trim();

      if (currentVal === '') {
        // Blank current field -> PRESERVE OLD SAVED ANSWER
        diffs.push({
          id: currentField.id,
          label: currentField.label,
          fieldType: currentField.fieldType,
          status: 'blank_preserved',
          oldValue: savedVal,
          newValue: '',
          finalValue: savedVal,
        });
        mergedFields.push({
          ...currentField,
          id: savedMatch.id,
          value: savedVal,
        });
      } else if (currentVal === savedVal) {
        // Value is unchanged
        diffs.push({
          id: currentField.id,
          label: currentField.label,
          fieldType: currentField.fieldType,
          status: 'unchanged',
          oldValue: savedVal,
          newValue: currentVal,
          finalValue: currentVal,
        });
        mergedFields.push({
          ...currentField,
          id: savedMatch.id,
          value: currentVal,
        });
      } else {
        // Value has changed
        diffs.push({
          id: currentField.id,
          label: currentField.label,
          fieldType: currentField.fieldType,
          status: 'changed',
          oldValue: savedVal,
          newValue: currentVal,
          finalValue: currentVal,
        });
        mergedFields.push({
          ...currentField,
          id: savedMatch.id,
          value: currentVal,
        });
      }
    } else {
      // Newly added field
      const currentVal = (currentField.value || '').trim();
      if (currentVal !== '') {
        diffs.push({
          id: currentField.id,
          label: currentField.label,
          fieldType: currentField.fieldType,
          status: 'newly_added',
          oldValue: undefined,
          newValue: currentVal,
          finalValue: currentVal,
        });
        mergedFields.push({
          ...currentField,
          value: currentVal,
        });
      }
    }
  }

  // Any saved field not present in current form -> PRESERVE HISTORICAL VALUE
  for (const savedField of safeSaved) {
    if (!processedSavedIds.has(savedField.id)) {
      diffs.push({
        id: savedField.id,
        label: savedField.label,
        fieldType: savedField.fieldType,
        status: 'missing_preserved',
        oldValue: savedField.value,
        newValue: undefined,
        finalValue: savedField.value,
      });
      mergedFields.push({
        ...savedField,
      });
    }
  }

  let changedCount = 0;
  let newCount = 0;
  let unchangedCount = 0;
  let blankPreservedCount = 0;
  let missingPreservedCount = 0;

  for (const d of diffs) {
    if (d.status === 'changed') changedCount++;
    else if (d.status === 'newly_added') newCount++;
    else if (d.status === 'unchanged') unchangedCount++;
    else if (d.status === 'blank_preserved') blankPreservedCount++;
    else if (d.status === 'missing_preserved') missingPreservedCount++;
  }

  return {
    changedCount,
    newCount,
    unchangedCount,
    blankPreservedCount,
    missingPreservedCount,
    diffs,
    mergedFields,
  };
}
