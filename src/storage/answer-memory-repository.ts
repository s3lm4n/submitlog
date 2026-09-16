import { getDB } from './db';
import { normalizeAnswerLabel } from '../assistant/answer-index';

export interface AnswerMemoryEntry {
  id: string; // normalizedLabel or `${hostname}::${normalizedLabel}`
  normalizedLabel: string;
  label: string;
  fieldType: string;
  value: string;
  updatedAt: string;
  hostname: string;
  formFingerprint?: string;
  source: 'draft' | 'archived';
}

export interface AnswerMemoryRepository {
  save(entry: AnswerMemoryEntry): Promise<void>;
  saveBatch(entries: AnswerMemoryEntry[]): Promise<void>;
  get(normalizedLabel: string, hostname?: string): Promise<AnswerMemoryEntry | undefined>;
  getAllForHost(hostname: string): Promise<Record<string, AnswerMemoryEntry>>;
  getAll(): Promise<AnswerMemoryEntry[]>;
  delete(id: string): Promise<void>;
  clear(): Promise<void>;
}

export function createAnswerMemoryRepository(): AnswerMemoryRepository {
  return {
    async save(entry: AnswerMemoryEntry): Promise<void> {
      const db = await getDB();
      const norm = normalizeAnswerLabel(entry.label || entry.normalizedLabel);
      const id = entry.hostname ? `${entry.hostname.toLowerCase()}::${norm}` : norm;
      const record: AnswerMemoryEntry = {
        ...entry,
        id,
        normalizedLabel: norm,
        updatedAt: entry.updatedAt || new Date().toISOString(),
      };
      await db.put('answer_memory', record);
    },

    async saveBatch(entries: AnswerMemoryEntry[]): Promise<void> {
      const db = await getDB();
      const tx = db.transaction('answer_memory', 'readwrite');
      for (const entry of entries) {
        const norm = normalizeAnswerLabel(entry.label || entry.normalizedLabel);
        const id = entry.hostname ? `${entry.hostname.toLowerCase()}::${norm}` : norm;
        const record: AnswerMemoryEntry = {
          ...entry,
          id,
          normalizedLabel: norm,
          updatedAt: entry.updatedAt || new Date().toISOString(),
        };
        await tx.store.put(record);
      }
      await tx.done;
    },

    async get(normalizedLabel: string, hostname?: string): Promise<AnswerMemoryEntry | undefined> {
      const db = await getDB();
      const norm = normalizeAnswerLabel(normalizedLabel);
      if (hostname) {
        const hostId = `${hostname.toLowerCase()}::${norm}`;
        const exact = await db.get('answer_memory', hostId);
        if (exact) return exact;
      }
      // Fallback: search any answer for this label, newest first
      const all = await db.getAllFromIndex('answer_memory', 'by-label', norm);
      if (all && all.length > 0) {
        all.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
        return all[0];
      }
      return undefined;
    },

    async getAllForHost(hostname: string): Promise<Record<string, AnswerMemoryEntry>> {
      const db = await getDB();
      const all = await db.getAll('answer_memory');
      const normHost = hostname.toLowerCase().trim();
      const result: Record<string, AnswerMemoryEntry> = {};

      // Sort newest first
      all.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

      // First add matching host entries, then global entries as fallback
      for (const item of all) {
        const key = item.normalizedLabel;
        const isMatch = item.hostname && item.hostname.toLowerCase() === normHost;
        if (isMatch) {
          if (!result[key] || result[key].hostname?.toLowerCase() !== normHost) {
            result[key] = item;
          }
        } else if (!result[key]) {
          result[key] = item;
        }
      }
      return result;
    },

    async getAll(): Promise<AnswerMemoryEntry[]> {
      const db = await getDB();
      const all = await db.getAll('answer_memory');
      return all.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    },

    async delete(id: string): Promise<void> {
      const db = await getDB();
      await db.delete('answer_memory', id);
    },

    async clear(): Promise<void> {
      const db = await getDB();
      await db.clear('answer_memory');
    },
  };
}
