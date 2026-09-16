import type { Submission } from '../models/submission';
import {
  normalizeLabel,
  extractFieldSignatures,
  calculateSignatureSimilarity,
  type FormFieldDescriptor,
} from './form-fingerprint';

export interface FormMatchResult {
  isMatch: boolean;
  confidence: number;
  matchedFieldCount: number;
  totalCurrentFields: number;
  totalSavedFields: number;
}

/**
 * Checks if two field types are logically compatible for matching and filling.
 */
export function areFieldTypesCompatible(typeA: string, typeB: string): boolean {
  const a = (typeA || 'text').toLowerCase();
  const b = (typeB || 'text').toLowerCase();
  if (a === b) return true;

  const textTypes = new Set(['text', 'email', 'tel', 'url', 'number', 'date', 'other']);
  if (textTypes.has(a) && textTypes.has(b)) return true;

  // Textarea can accept text and vice-versa if needed
  if ((a === 'textarea' && textTypes.has(b)) || (b === 'textarea' && textTypes.has(a))) {
    return true;
  }

  return false;
}

/**
 * Calculates token-level word overlap (Dice coefficient) between two normalized label strings.
 */
export function calculateLabelSimilarity(labelA: string, labelB: string): number {
  const normA = normalizeLabel(labelA);
  const normB = normalizeLabel(labelB);
  if (normA === normB) return 1.0;
  if (!normA || !normB) return 0.0;

  const wordsA = new Set(normA.split(' ').filter((w) => w.length > 0));
  const wordsB = new Set(normB.split(' ').filter((w) => w.length > 0));
  if (wordsA.size === 0 || wordsB.size === 0) return 0.0;

  let common = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) common++;
  }

  return (2 * common) / (wordsA.size + wordsB.size);
}

/**
 * Finds the best matching candidate field from a list of candidates for a target field.
 * Prefers exact normalized label match.
 * Falls back to strong word token similarity (>= 0.75) with compatible field type.
 */
export function findFieldMatch<T extends { label: string; fieldType: string; excluded?: boolean }>(
  target: { label: string; fieldType: string },
  candidates: T[],
): T | undefined {
  const targetNorm = normalizeLabel(target.label);
  if (!targetNorm) return undefined;

  // 1. Exact normalized label match with compatible field type
  for (const candidate of candidates) {
    if (candidate.excluded) continue;
    if (
      normalizeLabel(candidate.label) === targetNorm &&
      areFieldTypesCompatible(target.fieldType, candidate.fieldType)
    ) {
      return candidate;
    }
  }

  // 2. High confidence token similarity (>= 0.75) with compatible field type
  let bestCandidate: T | undefined = undefined;
  let bestSimilarity = 0;

  for (const candidate of candidates) {
    if (candidate.excluded) continue;
    if (!areFieldTypesCompatible(target.fieldType, candidate.fieldType)) continue;

    const sim = calculateLabelSimilarity(target.label, candidate.label);
    if (sim >= 0.75 && sim > bestSimilarity) {
      bestSimilarity = sim;
      bestCandidate = candidate;
    }
  }

  return bestCandidate;
}

/**
 * Evaluates whether a current detected form matches a saved submission.
 * Operates on normalized hostnames and non-sensitive field structures.
 */
export function matchForm(
  currentHostname: string,
  currentFields: FormFieldDescriptor[],
  savedSubmission: Submission,
): FormMatchResult {
  const normHostCurrent = (currentHostname || '')
    .toLowerCase()
    .replace(/^www\./, '')
    .trim();
  const normHostSaved = (savedSubmission.hostname || '')
    .toLowerCase()
    .replace(/^www\./, '')
    .trim();

  const nonExcludedSaved = savedSubmission.fields.filter((f) => !f.excluded);
  const nonExcludedCurrent = currentFields.filter((f) => !f.excluded);

  if (normHostCurrent !== normHostSaved) {
    return {
      isMatch: false,
      confidence: 0,
      matchedFieldCount: 0,
      totalCurrentFields: nonExcludedCurrent.length,
      totalSavedFields: nonExcludedSaved.length,
    };
  }

  const currentSigs = extractFieldSignatures(nonExcludedCurrent);
  const savedSigs = extractFieldSignatures(nonExcludedSaved);

  // Exact signature match
  if (
    currentSigs.length > 0 &&
    savedSigs.length > 0 &&
    currentSigs.length === savedSigs.length &&
    currentSigs.every((sig, idx) => sig === savedSigs[idx])
  ) {
    return {
      isMatch: true,
      confidence: 1.0,
      matchedFieldCount: currentSigs.length,
      totalCurrentFields: nonExcludedCurrent.length,
      totalSavedFields: nonExcludedSaved.length,
    };
  }

  // Field-by-field matching
  let matchedCount = 0;
  for (const savedField of nonExcludedSaved) {
    const match = findFieldMatch(savedField, nonExcludedCurrent);
    if (match) matchedCount++;
  }

  const jaccard = calculateSignatureSimilarity(currentSigs, savedSigs);
  const totalMax = Math.max(nonExcludedCurrent.length, nonExcludedSaved.length);
  const matchRatio = totalMax > 0 ? matchedCount / totalMax : 0;
  const confidence = Math.max(jaccard, matchRatio);

  // For forms with >= 3 fields, a 70% match indicates the same logical form (e.g., 1 new field added)
  // For small forms (< 3 fields), require 100% match
  const minRequiredRatio = totalMax >= 3 ? 0.7 : 1.0;
  const isMatch = matchedCount >= 1 && matchRatio >= minRequiredRatio;

  return {
    isMatch,
    confidence,
    matchedFieldCount: matchedCount,
    totalCurrentFields: nonExcludedCurrent.length,
    totalSavedFields: nonExcludedSaved.length,
  };
}
