import type { Submission } from '../models/submission';
import { getDB } from './db';

export interface SubmissionRepository {
  save(submission: Submission): Promise<void>;
  getById(id: string): Promise<Submission | undefined>;
  getAll(): Promise<Submission[]>; // newest first
  delete(id: string): Promise<void>;
  updateTitle(id: string, title: string): Promise<void>;
  search(query: string): Promise<Submission[]>;
}

export function createSubmissionRepository(): SubmissionRepository {
  return {
    async save(submission: Submission): Promise<void> {
      const db = await getDB();
      await db.put('submissions', submission);
    },

    async getById(id: string): Promise<Submission | undefined> {
      const db = await getDB();
      return db.get('submissions', id);
    },

    async getAll(): Promise<Submission[]> {
      const db = await getDB();
      const all = await db.getAllFromIndex('submissions', 'by-created');
      return all.reverse();
    },

    async delete(id: string): Promise<void> {
      const db = await getDB();
      await db.delete('submissions', id);
    },

    async updateTitle(id: string, title: string): Promise<void> {
      const db = await getDB();
      const submission = await db.get('submissions', id);
      if (submission) {
        submission.submissionTitle = title;
        await db.put('submissions', submission);
      }
    },

    async search(query: string): Promise<Submission[]> {
      const db = await getDB();
      const all = await db.getAllFromIndex('submissions', 'by-created');
      const reversed = all.reverse();

      const lowerQuery = query.toLowerCase();

      return reversed.filter((sub) => {
        if (sub.submissionTitle?.toLowerCase().includes(lowerQuery)) return true;
        if (sub.hostname.toLowerCase().includes(lowerQuery)) return true;

        for (const field of sub.fields) {
          if (field.label?.toLowerCase().includes(lowerQuery)) return true;
          if (field.value?.toLowerCase().includes(lowerQuery)) return true;
        }

        return false;
      });
    },
  };
}
