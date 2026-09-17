import { getDB } from './db';

/**
 * Persistent deletion tombstone for draft records.
 * Ensures that deleted drafts STAY deleted across service worker restarts and browser restarts,
 * preventing resurrection from:
 * - In-flight async writes
 * - Pending debounced focusout writes
 * - Periodic safety flushes (2.5s) from open tabs
 *
 * A draft may only be recreated when a genuine NEW user edit occurs after deletion
 * (clientTimestamp > deletedAt and revision > lastAcceptedRevision).
 */
export interface DraftTombstone {
  stableDraftId: string;
  deletedAt: number; // Date.now() timestamp of deletion (ms)
  lastAcceptedRevision?: number;
  expiresAt: number; // Expiry timestamp (ms)
}

export const DEFAULT_TOMBSTONE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface TombstoneRepository {
  set(tombstone: DraftTombstone): Promise<void>;
  get(stableDraftId: string): Promise<DraftTombstone | undefined>;
  delete(stableDraftId: string): Promise<void>;
  getAll(): Promise<DraftTombstone[]>;
  cleanupExpired(now?: number): Promise<number>;
  clearAll(): Promise<void>;
}

// In-memory fallback and fast-lookup cache
const memoryTombstones = new Map<string, DraftTombstone>();

export function createTombstoneRepository(): TombstoneRepository {
  return {
    async set(tombstone: DraftTombstone): Promise<void> {
      const norm = tombstone.stableDraftId.trim();
      const record: DraftTombstone = {
        ...tombstone,
        stableDraftId: norm,
        expiresAt: tombstone.expiresAt || tombstone.deletedAt + DEFAULT_TOMBSTONE_RETENTION_MS,
      };
      memoryTombstones.set(norm, record);
      try {
        const db = await getDB();
        await db.put('draft_tombstones', record);
      } catch {
        // Fallback to memory
      }
    },

    async get(stableDraftId: string): Promise<DraftTombstone | undefined> {
      if (!stableDraftId) return undefined;
      const norm = stableDraftId.trim();
      try {
        const db = await getDB();
        const stored = await db.get('draft_tombstones', norm);
        if (stored) {
          if (stored.expiresAt && stored.expiresAt < Date.now()) {
            await db.delete('draft_tombstones', norm);
            memoryTombstones.delete(norm);
            return undefined;
          }
          memoryTombstones.set(norm, stored);
          return stored;
        }
      } catch {
        // Fallback to memory
      }

      const mem = memoryTombstones.get(norm);
      if (mem && mem.expiresAt && mem.expiresAt < Date.now()) {
        memoryTombstones.delete(norm);
        return undefined;
      }
      return mem;
    },

    async delete(stableDraftId: string): Promise<void> {
      if (!stableDraftId) return;
      const norm = stableDraftId.trim();
      memoryTombstones.delete(norm);
      try {
        const db = await getDB();
        await db.delete('draft_tombstones', norm);
      } catch {
        // Fallback
      }
    },

    async getAll(): Promise<DraftTombstone[]> {
      const now = Date.now();
      try {
        const db = await getDB();
        const all = await db.getAll('draft_tombstones');
        return all.filter((t) => !t.expiresAt || t.expiresAt >= now);
      } catch {
        return Array.from(memoryTombstones.values()).filter(
          (t) => !t.expiresAt || t.expiresAt >= now,
        );
      }
    },

    async cleanupExpired(now: number = Date.now()): Promise<number> {
      let count = 0;
      try {
        const db = await getDB();
        const tx = db.transaction('draft_tombstones', 'readwrite');
        const index = tx.store.index('by-expires');
        let cursor = await index.openCursor(IDBKeyRange.upperBound(now, true));
        while (cursor) {
          count++;
          memoryTombstones.delete(cursor.value.stableDraftId);
          await cursor.delete();
          cursor = await cursor.continue();
        }
        await tx.done;
      } catch {
        for (const [id, t] of Array.from(memoryTombstones.entries())) {
          if (t.expiresAt && t.expiresAt < now) {
            memoryTombstones.delete(id);
            count++;
          }
        }
      }
      return count;
    },

    async clearAll(): Promise<void> {
      memoryTombstones.clear();
      try {
        const db = await getDB();
        await db.clear('draft_tombstones');
      } catch {
        // Ignore
      }
    },
  };
}

/**
 * Creates an in-memory tombstone repository backed by a given or fresh Map.
 * Useful for testing service worker restart simulation without touching IndexedDB.
 */
export function createInMemoryTombstoneRepository(
  backingMap: Map<string, DraftTombstone> = new Map(),
): TombstoneRepository {
  return {
    async set(tombstone: DraftTombstone): Promise<void> {
      const norm = tombstone.stableDraftId.trim();
      backingMap.set(norm, {
        ...tombstone,
        stableDraftId: norm,
        expiresAt: tombstone.expiresAt || tombstone.deletedAt + DEFAULT_TOMBSTONE_RETENTION_MS,
      });
    },
    async get(stableDraftId: string): Promise<DraftTombstone | undefined> {
      const norm = stableDraftId.trim();
      const t = backingMap.get(norm);
      if (t && t.expiresAt && t.expiresAt < Date.now()) {
        backingMap.delete(norm);
        return undefined;
      }
      return t;
    },
    async delete(stableDraftId: string): Promise<void> {
      backingMap.delete(stableDraftId.trim());
    },
    async getAll(): Promise<DraftTombstone[]> {
      const now = Date.now();
      return Array.from(backingMap.values()).filter((t) => !t.expiresAt || t.expiresAt >= now);
    },
    async cleanupExpired(now: number = Date.now()): Promise<number> {
      let count = 0;
      for (const [id, t] of Array.from(backingMap.entries())) {
        if (t.expiresAt && t.expiresAt < now) {
          backingMap.delete(id);
          count++;
        }
      }
      return count;
    },
    async clearAll(): Promise<void> {
      backingMap.clear();
    },
  };
}

const defaultTombstoneRepo = createTombstoneRepository();

/**
 * Records a deletion tombstone for a draft in persistent storage.
 */
export async function setDraftTombstone(
  stableDraftId: string,
  deletedAt: number = Date.now(),
  lastAcceptedRevision?: number,
  expiresAt?: number,
  repo?: TombstoneRepository,
): Promise<void> {
  if (!stableDraftId) return;
  const normId = stableDraftId.trim();
  const activeRepo = repo || defaultTombstoneRepo;
  await activeRepo.set({
    stableDraftId: normId,
    deletedAt,
    lastAcceptedRevision,
    expiresAt: expiresAt || deletedAt + DEFAULT_TOMBSTONE_RETENTION_MS,
  });
}

/**
 * Retrieves an active tombstone for a draft ID from persistent storage.
 */
export async function getDraftTombstone(
  stableDraftId: string,
  repo?: TombstoneRepository,
): Promise<DraftTombstone | undefined> {
  if (!stableDraftId) return undefined;
  const activeRepo = repo || defaultTombstoneRepo;
  return activeRepo.get(stableDraftId.trim());
}

/**
 * Clears an active tombstone from persistent storage.
 */
export async function clearDraftTombstone(
  stableDraftId: string,
  repo?: TombstoneRepository,
): Promise<void> {
  if (!stableDraftId) return;
  const activeRepo = repo || defaultTombstoneRepo;
  await activeRepo.delete(stableDraftId.trim());
}

/**
 * Clears all active tombstones (used in test teardown).
 */
export async function clearAllDraftTombstones(repo?: TombstoneRepository): Promise<void> {
  memoryTombstones.clear();
  const activeRepo = repo || defaultTombstoneRepo;
  await activeRepo.clearAll();
}

export const clearTombstoneRegistry = clearAllDraftTombstones;

/**
 * Evaluates whether an incoming autosave payload should be rejected due to a deletion tombstone.
 *
 * Returns:
 * - `true` if the write is stale / belongs to the pre-deletion era and must be REJECTED.
 * - `false` if there is no tombstone, or the edit is genuinely newer (in which case the tombstone is cleared).
 */
export async function isAutosaveRejectedByTombstone(
  stableDraftId: string,
  clientTimestamp?: number,
  revision?: number,
  repo?: TombstoneRepository,
): Promise<boolean> {
  if (!stableDraftId) return false;
  const activeRepo = repo || defaultTombstoneRepo;
  const tombstone = await activeRepo.get(stableDraftId);
  if (!tombstone) return false;

  const incomingTime = clientTimestamp || 0;

  // 1. If clientTimestamp is provided:
  if (incomingTime > 0) {
    // If clientTimestamp <= deletion time, it is definitely a stale write generated before/at deletion
    if (incomingTime <= tombstone.deletedAt) {
      return true;
    }

    // If clientTimestamp > tombstone.deletedAt, user has legitimately typed a new edit!
    // Clear the tombstone and allow the new draft to be persisted.
    await activeRepo.delete(stableDraftId);
    return false;
  }

  // 2. Where clientTimestamp is absent / 0, revision comparison is relevant:
  if (
    tombstone.lastAcceptedRevision !== undefined &&
    revision !== undefined &&
    revision > tombstone.lastAcceptedRevision
  ) {
    // Genuine newer revision despite missing timestamp
    await activeRepo.delete(stableDraftId);
    return false;
  }

  // Without a newer timestamp or a newer revision, reject stale write
  return true;
}
