import {
  createSubmissionRepository,
  type SubmissionRepository,
} from '../storage/submission-repository';
import { findFieldMatch } from '../matching/field-matcher';
import { isFieldSensitive, type AutosaveResponse } from './autosave-handler';
import { getOrBuildAnswerIndex, invalidateCachedAnswerIndex } from '../assistant/answer-index';
import type { Submission, CapturedField, FieldType } from '../models/submission';
import { SCHEMA_VERSION } from '../models/submission';
import { generateId } from '../utils/id';

export interface FieldStatusPayload {
  hostname: string;
  field: {
    label: string;
    fieldType: string;
    value: string;
  };
  allCurrentFields?: Array<{ label: string; fieldType: string; excluded?: boolean }>;
}

export interface FieldStatusResponse {
  matchingSubmissionId?: string;
  savedAnswer?: string;
  hasOtherSavedAnswers: boolean;
  totalSavedAnswers: number;
  privateBrowsing?: boolean;
}

export interface SaveFieldPayload {
  hostname: string;
  pageTitle: string;
  pageUrl: string;
  field: {
    label: string;
    fieldType: string;
    value: string;
  };
  allCurrentFields?: Array<{ label: string; fieldType: string; excluded?: boolean }>;
}

export interface BootstrapAssistantPayload {
  hostname: string;
}

export interface BootstrapAssistantResponse {
  availableAnswers: Record<string, { value: string; fieldType: string; count: number }>;
  privateBrowsing?: boolean;
}

/**
 * Bootstraps the field assistant for a page by providing all available answers from the AnswerIndex.
 */
export async function handleBootstrapAssistant(
  payload: BootstrapAssistantPayload,
  customRepo?: SubmissionRepository,
  isIncognito?: boolean,
): Promise<BootstrapAssistantResponse> {
  if (isIncognito) {
    return { availableAnswers: {}, privateBrowsing: true };
  }

  const index = await getOrBuildAnswerIndex(customRepo);
  const availableAnswers = index.getAllAvailableForHost(payload.hostname);
  return { availableAnswers };
}

/**
 * Checks for a saved answer for the focused field on the current host.
 */
export async function handleGetFieldStatus(
  payload: FieldStatusPayload,
  customRepo?: SubmissionRepository,
  isIncognito?: boolean,
): Promise<FieldStatusResponse> {
  if (isIncognito) {
    return {
      savedAnswer: '',
      hasOtherSavedAnswers: false,
      totalSavedAnswers: 0,
      privateBrowsing: true,
    };
  }

  const { hostname, field, allCurrentFields = [] } = payload;
  const repo = customRepo || createSubmissionRepository();

  if (isFieldSensitive(field.label, field.fieldType)) {
    return {
      savedAnswer: '',
      hasOtherSavedAnswers: false,
      totalSavedAnswers: 0,
    };
  }

  // 1. Try form matching first if form fields provided
  let sub: Submission | undefined = undefined;
  if (allCurrentFields.length > 0) {
    sub = await repo.findMatching(hostname, allCurrentFields);
  } else {
    const candidates = await repo.getAll();
    sub = candidates.find((c) => c.hostname.toLowerCase() === hostname.toLowerCase());
  }

  if (sub) {
    const matched = findFieldMatch(field, sub.fields);
    const nonExcludedAnswers = sub.fields.filter((f) => !f.excluded && f.value.trim() !== '');
    const totalSavedAnswers = nonExcludedAnswers.length;
    const savedAnswer = matched?.value || '';
    const hasOtherSavedAnswers = totalSavedAnswers > (savedAnswer.trim() !== '' ? 1 : 0);

    return {
      matchingSubmissionId: sub.id,
      savedAnswer,
      hasOtherSavedAnswers,
      totalSavedAnswers,
    };
  }

  // 2. Fallback to AnswerIndex for cross-submission suggestion matching
  const index = await getOrBuildAnswerIndex(repo);
  const suggestions = index.getSuggestions(field.label, hostname);

  if (suggestions.length > 0) {
    const top = suggestions[0];
    return {
      matchingSubmissionId: top?.submissionId,
      savedAnswer: top?.value || '',
      hasOtherSavedAnswers: suggestions.length > 1,
      totalSavedAnswers: suggestions.length,
    };
  }

  return {
    savedAnswer: '',
    hasOtherSavedAnswers: false,
    totalSavedAnswers: 0,
  };
}

/**
 * Handles explicit "Save this answer" or "Update saved answer" from the field assistant.
 * Writes to the user's permanent Archive (SubmissionRepository).
 */
export async function handleSaveFieldFromAssistant(
  payload: SaveFieldPayload,
  customRepo?: SubmissionRepository,
  isIncognito?: boolean,
): Promise<AutosaveResponse> {
  if (isIncognito) {
    return { status: 'private_browsing_blocked' };
  }

  const { hostname, pageTitle, pageUrl, field, allCurrentFields = [] } = payload;

  if (isFieldSensitive(field.label, field.fieldType)) {
    return { status: 'skipped' };
  }

  const trimmedValue = (field.value || '').trim();
  if (!trimmedValue) {
    return { status: 'unchanged' };
  }

  const repo = customRepo || createSubmissionRepository();

  // Find matching submission on this host
  let sub: Submission | undefined = undefined;
  if (allCurrentFields.length > 0) {
    sub = await repo.findMatching(hostname, allCurrentFields);
  } else {
    const all = await repo.getAll();
    sub = all.find((s) => s.hostname.toLowerCase() === hostname.toLowerCase());
  }

  const now = new Date().toISOString();

  if (!sub) {
    const newId = generateId();
    const newField: CapturedField = {
      id: generateId(),
      label: field.label,
      value: trimmedValue,
      fieldType: (field.fieldType as FieldType) || 'text',
      labelSource: 'label-for',
      excluded: false,
    };

    const newSub: Submission = {
      id: newId,
      schemaVersion: SCHEMA_VERSION,
      createdAt: now,
      updatedAt: now,
      pageTitle: pageTitle || hostname,
      pageUrl: pageUrl || `https://${hostname}/`,
      hostname,
      submissionTitle: `${pageTitle || hostname} - ${new Date().toLocaleDateString()}`,
      fields: [newField],
      captureVersion: '0.1.0',
      revisions: [
        {
          id: generateId(),
          createdAt: now,
          fields: [newField],
          changeNote: 'Initial capture from assistant',
        },
      ],
    };

    await repo.save(newSub);
    invalidateCachedAnswerIndex();
    return { status: 'saved', submissionId: newId, lastSaved: now };
  }

  // Existing submission: check if field already exists
  const existingField = findFieldMatch(field, sub.fields);
  if (existingField && existingField.value.trim() === trimmedValue) {
    return { status: 'unchanged', submissionId: sub.id, lastSaved: sub.updatedAt };
  }

  // Add revision checkpoint
  sub.revisions = [
    {
      id: generateId(),
      createdAt: now,
      fields: sub.fields.map((f) => ({ ...f })),
      changeNote: `Assistant updated ${field.label}`,
    },
    ...(sub.revisions || []),
  ];

  if (existingField) {
    existingField.value = trimmedValue;
  } else {
    sub.fields.push({
      id: generateId(),
      label: field.label,
      value: trimmedValue,
      fieldType: (field.fieldType as FieldType) || 'text',
      labelSource: 'label-for',
      excluded: false,
    });
  }

  sub.updatedAt = now;
  await repo.save(sub);
  invalidateCachedAnswerIndex();
  return { status: 'saved', submissionId: sub.id, lastSaved: now };
}
