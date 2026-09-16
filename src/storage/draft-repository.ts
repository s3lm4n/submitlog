import type { FormDraft } from '../models/draft';
import { buildDraftId, DRAFT_SCHEMA_VERSION } from '../models/draft';
import { getDB } from './db';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export interface DraftRepository {
  save(draft: FormDraft): Promise<void>;
  getById(id: string): Promise<FormDraft | undefined>;
  getByForm(
    origin: string,
    pathname: string,
    formFingerprint: string,
  ): Promise<FormDraft | undefined>;
  getByOrigin(origin: string): Promise<FormDraft[]>;
  delete(id: string): Promise<void>;
  deleteByOrigin(origin: string): Promise<void>;
  cleanupExpired(maxAgeMs?: number): Promise<number>;
}

export function createDraftRepository(): DraftRepository {
  return {
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
      formFingerprint: string,
    ): Promise<FormDraft | undefined> {
      const id = buildDraftId(origin, pathname, formFingerprint);
      const db = await getDB();
      const direct = await db.get('drafts', id);
      if (direct) return direct;

      // Fallback: search by origin index to tolerate minor pathname variations
      const normOrigin = (origin || '').toLowerCase().trim().replace(/\/+$/, '');
      const candidates = await db.getAllFromIndex('drafts', 'by-origin', normOrigin);
      const match = candidates.find(
        (d) => d.formFingerprint === formFingerprint && d.origin === normOrigin,
      );
      return match;
    },

    async getByOrigin(origin: string): Promise<FormDraft[]> {
      const normOrigin = (origin || '').toLowerCase().trim().replace(/\/+$/, '');
      const db = await getDB();
      const all = await db.getAllFromIndex('drafts', 'by-origin', normOrigin);
      return all.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    },

    async delete(id: string): Promise<void> {
      const db = await getDB();
      await db.delete('drafts', id);
    },

    async deleteByOrigin(origin: string): Promise<void> {
      const normOrigin = (origin || '').toLowerCase().trim().replace(/\/+$/, '');
      const db = await getDB();
      const all = await db.getAllFromIndex('drafts', 'by-origin', normOrigin);
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
