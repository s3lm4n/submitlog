import type { CapturedField } from '../models/submission';
import { findFormContainers, discoverFormFields } from './form-discoverer';
import { checkSensitiveField } from './sensitive-filter';
import { extractLabel, isLabelMeaningful } from './label-extractor';
import { extractValue } from './value-extractor';
import { scoreFormCandidate, isUtilityForm, type ScoredFieldCandidate } from './form-scorer';
import { generateId } from '../utils/id';

export interface CaptureResult {
  fields: CapturedField[];
  pageTitle: string;
  pageUrl: string;
  hostname: string;
  totalDetected: number;
  includedCount: number;
  excludedCount: number;
}

interface ProcessedCandidate {
  container: Element;
  fields: CapturedField[];
  scoredFields: ScoredFieldCandidate[];
  score: number;
  isMeaningful: boolean;
  excludedCount: number;
}

export function captureFormData(doc: Document, url: string): CaptureResult {
  const containers = findFormContainers(doc);
  const candidates: ProcessedCandidate[] = [];

  for (const container of containers) {
    if (isUtilityForm(container)) {
      continue;
    }

    const discovered = discoverFormFields(container);
    const validFields: CapturedField[] = [];
    const scoredFields: ScoredFieldCandidate[] = [];
    let excludedCount = 0;

    for (const field of discovered) {
      const { element, fieldType, groupValues } = field;
      const typedElement = element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

      // 1. Sensitive check
      const sensitiveCheck = checkSensitiveField(typedElement);
      if (sensitiveCheck.isSensitive) {
        excludedCount++;
        const labelResult = extractLabel(element, doc);
        validFields.push({
          id: generateId(),
          label: labelResult.label || 'Sensitive Field',
          value: '',
          fieldType,
          labelSource: labelResult.source,
          excluded: true,
          excludeReason: sensitiveCheck.reason,
        });
        continue;
      }

      // 2. Label extraction
      const labelResult = extractLabel(element, doc);
      if (!isLabelMeaningful(labelResult)) {
        // Unknown Field Policy: exclude controls with no meaningful label/identifier
        continue;
      }

      // 3. Value extraction & Empty Field Policy
      let value = '';
      if (fieldType === 'radio' && groupValues) {
        const selected = groupValues.find((v) => v.checked);
        if (!selected) {
          // Unselected radio group -> omit
          continue;
        }
        value = selected.value || selected.label;
      } else if (fieldType === 'checkbox' && groupValues && groupValues.length > 1) {
        const selected = groupValues.filter((v) => v.checked).map((v) => v.value || v.label);
        if (selected.length === 0) {
          // No checkboxes checked in group -> omit
          continue;
        }
        value = selected.join(', ');
      } else {
        value = extractValue(element);
      }

      // Empty Field Policy: omit empty optional fields
      if (!value || value.trim() === '') {
        continue;
      }

      validFields.push({
        id: generateId(),
        label: labelResult.label,
        value: value.trim(),
        fieldType,
        labelSource: labelResult.source,
        excluded: false,
      });

      scoredFields.push({
        fieldType,
        hasValue: true,
        isTextarea: fieldType === 'textarea',
        hasLabel: true,
      });
    }

    const scoreResult = scoreFormCandidate(container, scoredFields);

    if (scoreResult.isMeaningful && scoredFields.length > 0) {
      candidates.push({
        container,
        fields: validFields,
        scoredFields,
        score: scoreResult.score,
        isMeaningful: true,
        excludedCount,
      });
    }
  }

  const title = doc.title || 'Untitled Page';
  let hostname = '';
  try {
    const urlObj = new URL(url);
    hostname = urlObj.hostname;
  } catch {
    hostname = 'unknown';
  }

  // If no candidates qualify
  if (candidates.length === 0) {
    return {
      fields: [],
      pageTitle: title,
      pageUrl: url,
      hostname,
      totalDetected: 0,
      includedCount: 0,
      excludedCount: 0,
    };
  }

  // Pick the highest scoring candidate (do NOT merge unrelated forms)
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  if (!best) {
    return {
      fields: [],
      pageTitle: title,
      pageUrl: url,
      hostname,
      totalDetected: 0,
      includedCount: 0,
      excludedCount: 0,
    };
  }

  const included = best.fields.filter((f) => !f.excluded);

  return {
    fields: best.fields,
    pageTitle: title,
    pageUrl: url,
    hostname,
    totalDetected: best.fields.length,
    includedCount: included.length,
    excludedCount: best.excludedCount,
  };
}
