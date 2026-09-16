import type { CapturedField } from '../models/submission';
import { findFormCandidates, discoverFormFields, type FormCandidate } from './form-discoverer';
import { checkSensitiveField } from './sensitive-filter';
import { extractLabel, isLabelMeaningful } from './label-extractor';
import { extractValue } from './value-extractor';
import { scoreFormCandidate, isUtilityForm, type ScoredFieldCandidate } from './form-scorer';
import { generateId } from '../utils/id';

export interface CandidateDiagnostic {
  type: 'form' | 'role-form' | 'fieldset' | 'cluster' | 'shadow';
  structuralScore: number;
  meaningfulControlCount: number;
  answeredControlCount: number;
  isMeaningful: boolean;
  rejectionReason?: string;
  isChildFrame?: boolean;
}

export interface FormDiagnosticInfo {
  candidateCount: number;
  candidates: CandidateDiagnostic[];
}

export interface CaptureResult {
  fields: CapturedField[];
  pageTitle: string;
  pageUrl: string;
  hostname: string;
  totalDetected: number;
  includedCount: number;
  excludedCount: number;
  formDetected: boolean;
  answeredCount: number;
  inaccessibleFrameDetected?: boolean;
  diagnostics?: FormDiagnosticInfo;
}

interface ProcessedCandidate {
  candidate: FormCandidate;
  score: number;
  capturedAnswers: CapturedField[];
  meaningfulFieldCount: number;
  excludedCount: number;
  answeredCount: number;
}

export function captureFormData(doc: Document, url: string): CaptureResult {
  const candidates = findFormCandidates(doc);
  const processedCandidates: ProcessedCandidate[] = [];
  const diagnostics: CandidateDiagnostic[] = [];

  for (const candidate of candidates) {
    if (isUtilityForm(candidate.container)) {
      diagnostics.push({
        type: candidate.type,
        structuralScore: -999,
        meaningfulControlCount: candidate.elements.length,
        answeredControlCount: 0,
        isMeaningful: false,
        rejectionReason: 'Candidate rejected as search, navigation, or utility UI',
      });
      continue;
    }

    const discovered = discoverFormFields(candidate);
    const capturedAnswers: CapturedField[] = [];
    const scoredFields: ScoredFieldCandidate[] = [];
    let meaningfulFieldCount = 0;
    let excludedCount = 0;
    let answeredCount = 0;

    for (const field of discovered) {
      const { element, fieldType, groupValues } = field;
      const typedElement = element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

      // 1. Sensitive check (passwords, OTP, payment cards, tokens)
      const sensitiveCheck = checkSensitiveField(typedElement);
      if (sensitiveCheck.isSensitive) {
        excludedCount++;
        meaningfulFieldCount++;
        const labelResult = extractLabel(element, doc);
        capturedAnswers.push({
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
        // Unknown Field Policy: exclude controls lacking meaningful label/identifier
        continue;
      }

      meaningfulFieldCount++;

      // 3. Value extraction & Answer determination
      let value = '';
      if (fieldType === 'radio' && groupValues) {
        const selected = groupValues.find((v) => v.checked);
        if (selected) {
          value = selected.value || selected.label;
        }
      } else if (fieldType === 'checkbox' && groupValues && groupValues.length > 1) {
        const selected = groupValues.filter((v) => v.checked).map((v) => v.value || v.label);
        if (selected.length > 0) {
          value = selected.join(', ');
        }
      } else {
        value = extractValue(element);
      }

      const hasAnswer = Boolean(value && value.trim() !== '');
      if (hasAnswer) {
        answeredCount++;
        capturedAnswers.push({
          id: generateId(),
          label: labelResult.label,
          value: value.trim(),
          fieldType,
          labelSource: labelResult.source,
          excluded: false,
        });
      }

      // Structural Form Quality operates on ALL safe meaningful fields (regardless of value!)
      const isRequired =
        element.hasAttribute('required') || element.getAttribute('aria-required') === 'true';

      scoredFields.push({
        fieldType,
        hasValue: hasAnswer,
        isTextarea: fieldType === 'textarea',
        hasLabel: true,
        label: labelResult.label,
        isRequired,
      });
    }

    const scoreResult = scoreFormCandidate(candidate.container, scoredFields);

    diagnostics.push({
      type: candidate.type,
      structuralScore: scoreResult.score,
      meaningfulControlCount: meaningfulFieldCount,
      answeredControlCount: answeredCount,
      isMeaningful: scoreResult.isMeaningful,
      rejectionReason: scoreResult.isMeaningful ? undefined : scoreResult.reasons.join('; '),
    });

    if (scoreResult.isMeaningful && meaningfulFieldCount > 0) {
      processedCandidates.push({
        candidate,
        score: scoreResult.score,
        capturedAnswers,
        meaningfulFieldCount,
        excludedCount,
        answeredCount,
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
  if (processedCandidates.length === 0) {
    const hasIframes = doc.querySelectorAll('iframe').length > 0;
    return {
      fields: [],
      pageTitle: title,
      pageUrl: url,
      hostname,
      totalDetected: 0,
      includedCount: 0,
      excludedCount: 0,
      formDetected: false,
      answeredCount: 0,
      inaccessibleFrameDetected: hasIframes,
      diagnostics: {
        candidateCount: candidates.length,
        candidates: diagnostics,
      },
    };
  }

  // Pick the highest scoring candidate (do NOT merge unrelated forms)
  processedCandidates.sort((a, b) => b.score - a.score);
  const best = processedCandidates[0];
  if (!best) {
    return {
      fields: [],
      pageTitle: title,
      pageUrl: url,
      hostname,
      totalDetected: 0,
      includedCount: 0,
      excludedCount: 0,
      formDetected: false,
      answeredCount: 0,
      diagnostics: {
        candidateCount: candidates.length,
        candidates: diagnostics,
      },
    };
  }

  return {
    fields: best.capturedAnswers,
    pageTitle: title,
    pageUrl: url,
    hostname,
    totalDetected: best.meaningfulFieldCount,
    includedCount: best.answeredCount,
    excludedCount: best.excludedCount,
    formDetected: true,
    answeredCount: best.answeredCount,
    diagnostics: {
      candidateCount: candidates.length,
      candidates: diagnostics,
    },
  };
}
