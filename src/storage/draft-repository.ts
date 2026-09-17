import type { FormDraft, DraftField } from '../models/draft';
import { buildDraftId, DRAFT_SCHEMA_VERSION, normalizeDraftPathname } from '../models/draft';
import { normalizeAnswerLabel } from '../assistant/answer-index';
import { setDraftTombstone } from './tombstone-registry';
import { getDB } from './db';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Resolves the canonical stable draft ID for a given draft.
 * Maps legacy fingerprint-based IDs into stable container/workflow identities.
 */
export function getCanonicalDraftId(draft: FormDraft): string {
  return buildDraftId(draft.origin, draft.pathname, draft.formFamilyKey);
}

/**
 * Consolidates duplicate or multi-step draft records sharing the same workflow identity.
 * Merges fields (preserving older step answers, newest value wins) and returns
 * the canonical drafts and the redundant IDs to delete.
 */
export function consolidateDrafts(drafts: FormDraft[]): {
  canonicalDrafts: FormDraft[];
  deleteIds: string[];
} {
  const groups = new Map<string, FormDraft[]>();

  for (const draft of drafts) {
    const canonicalId = getCanonicalDraftId(draft);
    const existing = groups.get(canonicalId) || [];
    existing.push(draft);
    groups.set(canonicalId, existing);
  }

  const canonicalDrafts: FormDraft[] = [];
  const deleteIds: string[] = [];

  for (const [canonicalId, group] of groups.entries()) {
    const first = group[0];
    if (!first) continue;

    if (group.length === 1 && first.id === canonicalId) {
      canonicalDrafts.push(first);
      continue;
    }

    // Sort newest first by updatedAt
    group.sort(
      (a, b) =>
        new Date(b.updatedAt || b.createdAt).getTime() -
        new Date(a.updatedAt || a.createdAt).getTime(),
    );

    const newest = group[0] || first;
    // Find oldest creation timestamp
    const oldestCreatedAt = group.reduce((oldest, d) => {
      const dTime = new Date(d.createdAt).getTime();
      return dTime < new Date(oldest).getTime() ? d.createdAt : oldest;
    }, newest.createdAt);

    // Merge fields from all drafts in this workflow
    const mergedFields: Record<string, DraftField> = {};

    for (const draft of group) {
      for (const [key, field] of Object.entries(draft.fields || {})) {
        const normKey = normalizeAnswerLabel(field.label || key);
        const existingField = mergedFields[normKey];

        if (!existingField) {
          mergedFields[normKey] = { ...field };
        } else {
          // Compare revision and timestamp
          const existingTime = new Date(existingField.updatedAt).getTime();
          const candidateTime = new Date(field.updatedAt).getTime();
          const existingRev = existingField.revision || 0;
          const candidateRev = field.revision || 0;

          if (
            candidateRev > existingRev ||
            (candidateRev === existingRev && candidateTime > existingTime)
          ) {
            mergedFields[normKey] = { ...field };
          }
        }
      }
    }

    const mergedDraft: FormDraft = {
      ...newest,
      id: canonicalId,
      schemaVersion: newest.schemaVersion || DRAFT_SCHEMA_VERSION,
      origin: newest.origin,
      hostname: newest.hostname,
      pathname: newest.pathname,
      pageTitle: newest.pageTitle,
      pageUrl: newest.pageUrl,
      formFingerprint: newest.formFingerprint,
      createdAt: oldestCreatedAt,
      updatedAt: newest.updatedAt,
      fields: mergedFields,
    };

    canonicalDrafts.push(mergedDraft);

    // Mark any non-canonical or duplicate draft IDs for deletion
    for (const draft of group) {
      if (draft.id !== canonicalId) {
        deleteIds.push(draft.id);
      }
    }
  }

  return {
    canonicalDrafts,
    deleteIds,
  };
}

export interface DraftRepository {
  save(draft: FormDraft): Promise<void>;
  getById(id: string): Promise<FormDraft | undefined>;
  getByForm(
    origin: string,
    pathname: string,
    formFamilyOrFingerprint?: string,
  ): Promise<FormDraft | undefined>;
  getByOrigin(origin: string): Promise<FormDraft[]>;
  getAll(): Promise<FormDraft[]>;
  consolidateDuplicates?(): Promise<{ consolidatedCount: number; deletedCount: number }>;
  delete(id: string): Promise<void>;
  deleteByOrigin(origin: string): Promise<void>;
  cleanupExpired(maxAgeMs?: number): Promise<number>;
}

export function createDraftRepository(): DraftRepository {
  return {
    async getAll(): Promise<FormDraft[]> {
      const db = await getDB();
      const all = await db.getAll('drafts');
      const { canonicalDrafts, deleteIds } = consolidateDrafts(all);

      if (deleteIds.length > 0) {
        // Clean up duplicates in background
        (async () => {
          try {
            const tx = db.transaction('drafts', 'readwrite');
            for (const id of deleteIds) {
              await tx.store.delete(id);
            }
            for (const canonical of canonicalDrafts) {
              await tx.store.put(canonical);
            }
            await tx.done;
          } catch {
            // ignore background cleanup error
          }
        })();
      }

      return canonicalDrafts.sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      );
    },

    async consolidateDuplicates(): Promise<{ consolidatedCount: number; deletedCount: number }> {
      const db = await getDB();
      const all = await db.getAll('drafts');
      const { canonicalDrafts, deleteIds } = consolidateDrafts(all);

      if (deleteIds.length === 0 && canonicalDrafts.length === all.length) {
        return { consolidatedCount: 0, deletedCount: 0 };
      }

      const tx = db.transaction('drafts', 'readwrite');
      for (const id of deleteIds) {
        await tx.store.delete(id);
      }
      for (const canonical of canonicalDrafts) {
        await tx.store.put(canonical);
      }
      await tx.done;

      return {
        consolidatedCount: canonicalDrafts.length,
        deletedCount: deleteIds.length,
      };
    },

    async save(draft: FormDraft): Promise<void> {
      const db = await getDB();
      const readyToSave: FormDraft = {
        ...draft,
        schemaVersion: draft.schemaVersion || DRAFT_SCHEMA_VERSION,
        updatedAt: draft.updatedAt || new Date().toISOString(),
      };
      await db.put('drafts', readyToSave);
    },

    async getById(id: string): Promise<FormDraft | undefined> {
      const db = await getDB();
      return await db.get('drafts', id);
    },

    async getByForm(
      origin: string,
      pathname: string,
      formFamilyOrFingerprint?: string,
    ): Promise<FormDraft | undefined> {
      const db = await getDB();

      // 1. Direct lookup with family key or fingerprint
      if (formFamilyOrFingerprint) {
        const idWithFamily = buildDraftId(origin, pathname, formFamilyOrFingerprint);
        const directWithFamily = await db.get('drafts', idWithFamily);
        if (directWithFamily) return directWithFamily;
      }

      // 2. Base stable draft ID lookup (${origin}|${pathname})
      const baseId = buildDraftId(origin, pathname);
      const baseDirect = await db.get('drafts', baseId);
      if (baseDirect) return baseDirect;

      // 3. Fallback search by origin index
      const normOrigin = (origin || '').toLowerCase().trim().replace(/\/+$/, '');
      const normPath = normalizeDraftPathname(pathname);
      const candidates = await db.getAllFromIndex('drafts', 'by-origin', normOrigin);

      // Match by normalized pathname and family or fingerprint
      const match =
        candidates.find(
          (d) =>
            d.origin === normOrigin &&
            normalizeDraftPathname(d.pathname) === normPath &&
            (!formFamilyOrFingerprint ||
              d.formFamilyKey === formFamilyOrFingerprint ||
              d.formFingerprint === formFamilyOrFingerprint),
        ) ||
        candidates.find(
          (d) => d.origin === normOrigin && normalizeDraftPathname(d.pathname) === normPath,
        );

      return match;
    },

    async getByOrigin(origin: string): Promise<FormDraft[]> {
      const normOrigin = (origin || '').toLowerCase().trim().replace(/\/+$/, '');
      const db = await getDB();
      const all = await db.getAllFromIndex('drafts', 'by-origin', normOrigin);
      const { canonicalDrafts } = consolidateDrafts(all);
      return canonicalDrafts.sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      );
    },

    async delete(id: string): Promise<void> {
      const db = await getDB();
      const existing = await db.get('drafts', id);
      const now = Date.now();
      let maxRev: number | undefined;
      if (existing?.fields) {
        for (const f of Object.values(existing.fields)) {
          if (f.revision !== undefined && (maxRev === undefined || f.revision > maxRev)) {
            maxRev = f.revision;
          }
        }
      }
      await setDraftTombstone(id, now, maxRev);
      if (existing) {
        const canon = getCanonicalDraftId(existing);
        if (canon !== id) {
          await setDraftTombstone(canon, now, maxRev);
        }
      }
      await db.delete('drafts', id);
    },

    async deleteByOrigin(origin: string): Promise<void> {
      const normOrigin = (origin || '').toLowerCase().trim().replace(/\/+$/, '');
      const db = await getDB();
      const all = await db.getAllFromIndex('drafts', 'by-origin', normOrigin);
      const now = Date.now();
      for (const draft of all) {
        let maxRev: number | undefined;
        if (draft.fields) {
          for (const f of Object.values(draft.fields)) {
            if (f.revision !== undefined && (maxRev === undefined || f.revision > maxRev)) {
              maxRev = f.revision;
            }
          }
        }
        await setDraftTombstone(draft.id, now, maxRev);
        const canon = getCanonicalDraftId(draft);
        if (canon !== draft.id) {
          await setDraftTombstone(canon, now, maxRev);
        }
      }
      const tx = db.transaction('drafts', 'readwrite');
      for (const draft of all) {
        await tx.store.delete(draft.id);
      }
      await tx.done;
    },

    async cleanupExpired(maxAgeMs: number = THIRTY_DAYS_MS): Promise<number> {
      const db = await getDB();
      const all = await db.getAll('drafts');
      const now = Date.now();
      let deletedCount = 0;

      const tx = db.transaction('drafts', 'readwrite');
      for (const draft of all) {
        const lastUpdated = new Date(draft.updatedAt || draft.createdAt).getTime();
        if (now - lastUpdated > maxAgeMs) {
          await tx.store.delete(draft.id);
          deletedCount++;
        }
      }
      await tx.done;
      return deletedCount;
    },
  };
}
