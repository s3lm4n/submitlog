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
import { normalizeAnswerLabel, invalidateCachedAnswerIndex } from '../assistant/answer-index';
import {
  createAnswerMemoryRepository,
  type AnswerMemoryRepository,
} from '../storage/answer-memory-repository';
import {
  isAutosaveRejectedByTombstone,
  type TombstoneRepository,
} from '../storage/tombstone-registry';

export interface AutosaveFieldPayload {
  editingSessionId?: string;
  origin?: string;
  pathname?: string;
  formFingerprint?: string;
  formFamilyKey?: string;
  hostname: string;
  pageTitle: string;
  pageUrl: string;
  matchingSubmissionId?: string | null;
  clientTimestamp?: number;
  revision?: number;
  field: {
    label: string;
    value: string;
    fieldType: string;
  };
  allCurrentFields?: Array<{ label: string; fieldType: string; excluded?: boolean }>;
}

export interface AutosaveResponse {
  status:
    'saved' | 'unchanged' | 'skipped' | 'error' | 'private_browsing_blocked' | 'deleted_tombstone';
  submissionId?: string;
  draftId?: string;
  lastSaved?: string;
  error?: string;
}

import { isSensitiveText, isElementSensitive } from '../security/sensitive-patterns';

/**
 * Validates if a field candidate is sensitive and should never be autosaved.
 */
export function isFieldSensitive(
  labelOrElement: string | HTMLElement,
  fieldType?: string,
): boolean {
  if (!labelOrElement) return false;
  const fType = (fieldType || '').toLowerCase();
  if (fType === 'password' || fType === 'file' || fType === 'hidden') return true;

  if (typeof labelOrElement !== 'string') {
    return isElementSensitive(labelOrElement).isSensitive;
  }

  const label = labelOrElement;
  return isSensitiveText(label);
}

/**
 * Resolves normalized origin from payload or URL.
 */
function resolveOrigin(payload: AutosaveFieldPayload): string {
  if (
    payload.origin &&
    payload.origin.trim() &&
    payload.origin !== 'null' &&
    !payload.origin.startsWith('null')
  ) {
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
  isIncognitoOrAnswerMemoryRepo?: boolean | AnswerMemoryRepository,
  customAnswerMemoryRepo?: AnswerMemoryRepository,
  customTombstoneRepo?: TombstoneRepository,
): Promise<AutosaveResponse> {
  try {
    const isIncognito =
      typeof isIncognitoOrAnswerMemoryRepo === 'boolean' ? isIncognitoOrAnswerMemoryRepo : false;
    const answerMemoryRepo =
      typeof isIncognitoOrAnswerMemoryRepo !== 'boolean' && isIncognitoOrAnswerMemoryRepo
        ? isIncognitoOrAnswerMemoryRepo
        : customAnswerMemoryRepo;

    // 0. Authoritative private / incognito browsing guard
    if (isIncognito) {
      return { status: 'private_browsing_blocked' };
    }

    const {
      editingSessionId: _editingSessionId = 'session-default',
      hostname: rawHostname,
      pageTitle,
      pageUrl,
      field,
      allCurrentFields = [],
    } = payload;
    const hostname =
      rawHostname ||
      (pageUrl
        ? (() => {
            try {
              return new URL(pageUrl).hostname;
            } catch {
              return 'localhost';
            }
          })()
        : 'localhost');

    // 1. Sensitive field safety guard
    if (isFieldSensitive(field.label, field.fieldType)) {
      return { status: 'skipped' };
    }

    const trimmedValue = (field.value || '').trim();
    const origin = resolveOrigin(payload);
    const pathname = normalizeDraftPathname(payload.pathname || payload.pageUrl || '/');
    const formFingerprint =
      payload.formFingerprint || computeFormFingerprint(hostname, allCurrentFields);
    const draftId = buildDraftId(origin, pathname, payload.formFamilyKey);
    const normLabel = normalizeAnswerLabel(field.label);

    // Stale recreation tombstone protection: reject if draft was deleted and this is a stale write
    if (
      await isAutosaveRejectedByTombstone(
        draftId,
        payload.clientTimestamp,
        payload.revision,
        customTombstoneRepo,
      )
    ) {
      return { status: 'deleted_tombstone' };
    }

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

    const existingDraft =
      (await draftRepo.getByForm(origin, pathname, payload.formFamilyKey)) ||
      (await draftRepo.getById(draftId));
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
        revision: payload.revision,
        clientTimestamp: payload.clientTimestamp,
      };

      const newDraft: FormDraft = {
        id: draftId,
        schemaVersion: DRAFT_SCHEMA_VERSION,
        origin,
        hostname,
        pathname,
        formFamilyKey: payload.formFamilyKey,
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

      // Persist to Answer Memory
      try {
        const memoryRepo = answerMemoryRepo || createAnswerMemoryRepository();
        await memoryRepo.save({
          id: `${hostname.toLowerCase()}::${normLabel}`,
          normalizedLabel: normLabel,
          label: field.label,
          fieldType: field.fieldType,
          value: trimmedValue,
          updatedAt: now,
          hostname,
          formFingerprint,
          source: 'draft',
        });
        invalidateCachedAnswerIndex();
      } catch {
        // Fallback for mock environments
      }

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
      // Stale write rejection: if clientTimestamp or revision is older than existing, reject write
      if (
        payload.clientTimestamp &&
        existingField.clientTimestamp &&
        payload.clientTimestamp < existingField.clientTimestamp
      ) {
        return {
          status: 'unchanged',
          draftId: existingDraft.id,
          submissionId: existingDraft.id,
          lastSaved: existingDraft.updatedAt,
        };
      }
      if (payload.revision && existingField.revision && payload.revision < existingField.revision) {
        return {
          status: 'unchanged',
          draftId: existingDraft.id,
          submissionId: existingDraft.id,
          lastSaved: existingDraft.updatedAt,
        };
      }

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

    // Update draft field with newest revision/timestamp
    existingDraft.fields[normLabel] = {
      id: existingField?.id || generateId(),
      label: field.label,
      value: trimmedValue,
      fieldType: (field.fieldType as FieldType) || 'text',
      updatedAt: now,
      revision: payload.revision ?? (existingField?.revision || 0) + 1,
      clientTimestamp: payload.clientTimestamp ?? Date.now(),
    };
    existingDraft.updatedAt = now;
    existingDraft.formFingerprint = formFingerprint;
    if (payload.formFamilyKey) existingDraft.formFamilyKey = payload.formFamilyKey;
    if (pageTitle) existingDraft.pageTitle = pageTitle;
    if (pageUrl) existingDraft.pageUrl = pageUrl;

    await draftRepo.save(existingDraft);

    // Persist to Answer Memory
    if (trimmedValue !== '') {
      try {
        const memoryRepo = answerMemoryRepo || createAnswerMemoryRepository();
        await memoryRepo.save({
          id: `${hostname.toLowerCase()}::${normLabel}`,
          normalizedLabel: normLabel,
          label: field.label,
          fieldType: field.fieldType,
          value: trimmedValue,
          updatedAt: now,
          hostname,
          formFingerprint,
          source: 'draft',
        });
        invalidateCachedAnswerIndex();
      } catch {
        // Fallback for mock environments
      }
    }

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
