import type {
  CapturedField,
  FieldType,
  Submission,
  SubmissionRevision,
} from '../models/submission';
import { SCHEMA_VERSION } from '../models/submission';
import type { FormDraft, DraftField } from '../models/draft';
import { DRAFT_SCHEMA_VERSION, buildDraftId, normalizeDraftPathname } from '../models/draft';
import { generateId } from '../utils/id';
import { createDraftRepository, type DraftRepository } from '../storage/draft-repository';
import type { SubmissionRepository } from '../storage/submission-repository';
import { computeFormFingerprint } from '../matching/form-fingerprint';
import { findFieldMatch } from '../matching/field-matcher';
import { normalizeAnswerLabel } from '../assistant/answer-index';

export interface AutosaveFieldPayload {
  editingSessionId?: string;
  origin?: string;
  pathname?: string;
  formFingerprint?: string;
  hostname: string;
  pageTitle: string;
  pageUrl: string;
  matchingSubmissionId?: string | null;
  field: {
    label: string;
    value: string;
    fieldType: string;
  };
  allCurrentFields?: Array<{ label: string; fieldType: string; excluded?: boolean }>;
}

export interface AutosaveResponse {
  status: 'saved' | 'unchanged' | 'skipped' | 'error' | 'private_browsing_blocked';
  submissionId?: string;
  draftId?: string;
  lastSaved?: string;
  error?: string;
}

const SENSITIVE_PATTERNS =
  /password|passwd|pwd|otp|totp|mfa|cvv|cvc|card.?number|credit.?card|cc.?num|secret|token|auth.?token|auth.?code|verification.?code|security.?code|ssn|social.?security|pin.?code|one.?time/i;

/**
 * Validates if a field candidate is sensitive and should never be autosaved.
 */
export function isFieldSensitive(label: string, fieldType: string): boolean {
  if ((fieldType || '').toLowerCase() === 'password') return true;
  if ((fieldType || '').toLowerCase() === 'file') return true;
  const cleanLabel = (label || '').replace(/[\s\-_]+/g, '');
  if (SENSITIVE_PATTERNS.test(label || '') || SENSITIVE_PATTERNS.test(cleanLabel)) return true;
  return false;
}

/**
 * Resolves normalized origin from payload or URL.
 */
function resolveOrigin(payload: AutosaveFieldPayload): string {
  if (payload.origin && payload.origin.trim()) {
    return payload.origin.toLowerCase().trim().replace(/\/+$/, '');
  }
  try {
    return new URL(payload.pageUrl).origin.toLowerCase().trim().replace(/\/+$/, '');
  } catch {
    return `https://${(payload.hostname || 'unknown').toLowerCase().trim()}`;
  }
}

/**
 * Handles incoming field-level draft autosave in the background service worker.
 * Persists continuous drafts in extension-owned DraftRepository, strictly isolated from the Archive.
 */
export async function handleAutosaveMessage(
  payload: AutosaveFieldPayload,
  customRepo?: DraftRepository | SubmissionRepository,
  isIncognito?: boolean,
): Promise<AutosaveResponse> {
  try {
    // 0. Authoritative private / incognito browsing guard
    if (isIncognito) {
      return { status: 'private_browsing_blocked' };
    }

    const {
      editingSessionId: _editingSessionId = 'session-default',
      hostname,
      pageTitle,
      pageUrl,
      field,
      allCurrentFields = [],
    } = payload;

    // 1. Sensitive field safety guard
    if (isFieldSensitive(field.label, field.fieldType)) {
      return { status: 'skipped' };
    }

    const trimmedValue = (field.value || '').trim();
    const origin = resolveOrigin(payload);
    const pathname = normalizeDraftPathname(payload.pathname || payload.pageUrl || '/');
    const formFingerprint =
      payload.formFingerprint || computeFormFingerprint(hostname, allCurrentFields);
    const draftId = buildDraftId(origin, pathname, formFingerprint);
    const normLabel = normalizeAnswerLabel(field.label);

    // Support legacy SubmissionRepository mock for backward-compatibility in legacy tests
    const isLegacySubRepo =
      customRepo && typeof (customRepo as SubmissionRepository).findMatching === 'function';

    if (isLegacySubRepo) {
      return await handleLegacySubRepoAutosave(
        payload,
        customRepo as SubmissionRepository,
        trimmedValue,
        formFingerprint,
      );
    }

    // Modern isolated DraftRepository flow:
    const draftRepo: DraftRepository = (customRepo as DraftRepository) || createDraftRepository();

    const existingDraft = await draftRepo.getByForm(origin, pathname, formFingerprint);
    const now = new Date().toISOString();

    if (!existingDraft) {
      // Don't create draft for empty value
      if (trimmedValue === '') {
        return { status: 'skipped' };
      }

      const newDraftField: DraftField = {
        id: generateId(),
        label: field.label,
        value: trimmedValue,
        fieldType: (field.fieldType as FieldType) || 'text',
        updatedAt: now,
      };

      const newDraft: FormDraft = {
        id: draftId,
        schemaVersion: DRAFT_SCHEMA_VERSION,
        origin,
        hostname,
        pathname,
        pageTitle: pageTitle || hostname,
        pageUrl: pageUrl || `${origin}/`,
        formFingerprint,
        createdAt: now,
        updatedAt: now,
        fields: {
          [normLabel]: newDraftField,
        },
      };

      await draftRepo.save(newDraft);
      return {
        status: 'saved',
        draftId,
        submissionId: draftId,
        lastSaved: now,
      };
    }

    // Existing draft: check if field value changed
    const existingField = existingDraft.fields[normLabel];
    if (existingField) {
      // Empty value does NOT erase historical draft answer
      if (trimmedValue === '') {
        return {
          status: 'unchanged',
          draftId: existingDraft.id,
          submissionId: existingDraft.id,
          lastSaved: existingDraft.updatedAt,
        };
      }

      // Value deduplication: if identical, skip write
      if (existingField.value.trim() === trimmedValue) {
        return {
          status: 'unchanged',
          draftId: existingDraft.id,
          submissionId: existingDraft.id,
          lastSaved: existingDraft.updatedAt,
        };
      }
    } else {
      if (trimmedValue === '') {
        return {
          status: 'skipped',
          draftId: existingDraft.id,
          submissionId: existingDraft.id,
          lastSaved: existingDraft.updatedAt,
        };
      }
    }

    // Update draft field
    existingDraft.fields[normLabel] = {
      id: existingField?.id || generateId(),
      label: field.label,
      value: trimmedValue,
      fieldType: (field.fieldType as FieldType) || 'text',
      updatedAt: now,
    };
    existingDraft.updatedAt = now;

    await draftRepo.save(existingDraft);
    return {
      status: 'saved',
      draftId: existingDraft.id,
      submissionId: existingDraft.id,
      lastSaved: now,
    };
  } catch (err) {
    return { status: 'error', error: String(err) };
  }
}

/**
 * Legacy autosave handler to maintain full compatibility with legacy mock submission repos.
 */
async function handleLegacySubRepoAutosave(
  payload: AutosaveFieldPayload,
  repo: SubmissionRepository,
  trimmedValue: string,
  formFingerprint: string,
): Promise<AutosaveResponse> {
  const {
    editingSessionId = 'session-default',
    hostname,
    pageTitle,
    pageUrl,
    matchingSubmissionId,
    field,
    allCurrentFields = [],
  } = payload;

  let sub: Submission | undefined = undefined;
  if (matchingSubmissionId) {
    sub = await repo.getById(matchingSubmissionId);
  }

  if (!sub) {
    const allSubs = await repo.getAll();
    const sessionMatch = allSubs.find(
      (c) => c.hostname === hostname && c.lastEditingSessionId === editingSessionId,
    );
    if (sessionMatch) {
      sub = sessionMatch;
    } else if (formFingerprint) {
      const fpMatch = allSubs.find(
        (c) => c.hostname === hostname && c.formFingerprint === formFingerprint,
      );
      if (fpMatch) sub = fpMatch;
    }
  }

  if (!sub && allCurrentFields.length > 0) {
    sub = await repo.findMatching(hostname, allCurrentFields);
  }

  if (!sub) {
    if (trimmedValue === '') return { status: 'skipped' };

    const newId = generateId();
    const now = new Date().toISOString();
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
      formFingerprint,
      revisions: [
        {
          id: generateId(),
          createdAt: now,
          fields: [newField],
          changeNote: 'Initial draft autosave',
        },
      ],
      lastEditingSessionId: editingSessionId,
      isDraft: true,
    };

    await repo.save(newSub);
    return { status: 'saved', submissionId: newId, draftId: newId, lastSaved: now };
  }

  const existingField = findFieldMatch(
    { label: field.label, fieldType: field.fieldType },
    sub.fields,
  );

  if (existingField) {
    if (trimmedValue === '') {
      return {
        status: 'unchanged',
        submissionId: sub.id,
        draftId: sub.id,
        lastSaved: sub.updatedAt,
      };
    }
    if (existingField.value.trim() === trimmedValue) {
      return {
        status: 'unchanged',
        submissionId: sub.id,
        draftId: sub.id,
        lastSaved: sub.updatedAt,
      };
    }
  } else {
    if (trimmedValue === '') {
      return { status: 'skipped', submissionId: sub.id, draftId: sub.id, lastSaved: sub.updatedAt };
    }
  }

  const isNewSession = !sub.lastEditingSessionId || sub.lastEditingSessionId !== editingSessionId;
  if (isNewSession) {
    const preEditSnapshot: SubmissionRevision = {
      id: generateId(),
      createdAt: new Date().toISOString(),
      fields: sub.fields.map((f) => ({ ...f })),
      changeNote: `Editing session ${new Date().toLocaleDateString()}`,
    };
    sub.revisions = [preEditSnapshot, ...(sub.revisions || [])];
    sub.lastEditingSessionId = editingSessionId;
  }

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

  const now = new Date().toISOString();
  sub.updatedAt = now;
  sub.schemaVersion = SCHEMA_VERSION;

  await repo.save(sub);
  return { status: 'saved', submissionId: sub.id, draftId: sub.id, lastSaved: now };
}

/**
 * Retrieves the matching active draft for a form.
 */
export async function handleGetDraft(
  origin: string,
  pathname: string,
  formFingerprint: string,
  customDraftRepo?: DraftRepository,
): Promise<FormDraft | null> {
  const repo = customDraftRepo || createDraftRepository();
  const draft = await repo.getByForm(origin, pathname, formFingerprint);
  return draft || null;
}

/**
 * Clears an active draft without affecting the Archive.
 */
export async function handleClearDraft(
  draftId: string,
  customDraftRepo?: DraftRepository,
): Promise<{ success: boolean }> {
  const repo = customDraftRepo || createDraftRepository();
  await repo.delete(draftId);
  return { success: true };
}
