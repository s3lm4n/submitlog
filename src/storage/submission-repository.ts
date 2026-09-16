import type { Submission } from '../models/submission';
import { SCHEMA_VERSION } from '../models/submission';
import { computeFormFingerprint } from '../matching/form-fingerprint';
import { matchForm } from '../matching/field-matcher';
import { getDB } from './db';

export interface SubmissionRepository {
  save(submission: Submission): Promise<void>;
  getById(id: string): Promise<Submission | undefined>;
  getAll(): Promise<Submission[]>; // newest first
  delete(id: string): Promise<void>;
  updateTitle(id: string, title: string): Promise<void>;
  search(query: string): Promise<Submission[]>;
  findMatching(
    hostname: string,
    fields: Array<{ label: string; fieldType: string; excluded?: boolean }>,
  ): Promise<Submission | undefined>;
}

/**
 * Safely migrates older v1 submissions into v2 with fingerprints and revisions.
 */
export function migrateSubmission(raw: Submission): Submission {
  if (!raw) return raw;
  const migrated: Submission = { ...raw };

  if (!migrated.schemaVersion || migrated.schemaVersion < SCHEMA_VERSION) {
    migrated.schemaVersion = SCHEMA_VERSION;
  }

  if (!migrated.updatedAt) {
    migrated.updatedAt = migrated.createdAt;
  }

  if (!migrated.formFingerprint) {
    migrated.formFingerprint = computeFormFingerprint(migrated.hostname, migrated.fields);
  }

  if (!migrated.revisions || migrated.revisions.length === 0) {
    migrated.revisions = [
      {
        id: migrated.id,
        createdAt: migrated.createdAt,
        fields: [...migrated.fields],
        changeNote: 'Initial capture',
      },
    ];
  }

  return migrated;
}

export function createSubmissionRepository(): SubmissionRepository {
  return {
    async save(submission: Submission): Promise<void> {
      const db = await getDB();
      const readyToSave = migrateSubmission(submission);
      if (!readyToSave.updatedAt) {
        readyToSave.updatedAt = new Date().toISOString();
      }
      await db.put('submissions', readyToSave);
    },

    async getById(id: string): Promise<Submission | undefined> {
      const db = await getDB();
      const raw = await db.get('submissions', id);
      return raw ? migrateSubmission(raw) : undefined;
    },

    async getAll(): Promise<Submission[]> {
      const db = await getDB();
      const all = await db.getAllFromIndex('submissions', 'by-created');
      return all.reverse().map(migrateSubmission);
    },

    async delete(id: string): Promise<void> {
      const db = await getDB();
      await db.delete('submissions', id);
    },

    async updateTitle(id: string, title: string): Promise<void> {
      const db = await getDB();
      const raw = await db.get('submissions', id);
      if (raw) {
        const submission = migrateSubmission(raw);
        submission.submissionTitle = title;
        submission.updatedAt = new Date().toISOString();
        await db.put('submissions', submission);
      }
    },

    async search(query: string): Promise<Submission[]> {
      const db = await getDB();
      const all = await db.getAllFromIndex('submissions', 'by-created');
      const reversed = all.reverse().map(migrateSubmission);

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

    async findMatching(
      hostname: string,
      fields: Array<{ label: string; fieldType: string; excluded?: boolean }>,
    ): Promise<Submission | undefined> {
      const db = await getDB();
      // Fetch submissions for hostname using index
      const candidates = await db.getAllFromIndex('submissions', 'by-hostname', hostname);
      if (!candidates || candidates.length === 0) {
        return undefined;
      }

      // Sort newest first by updatedAt / createdAt
      const migrated = candidates.map(migrateSubmission).sort((a, b) => {
        const timeA = new Date(a.updatedAt || a.createdAt).getTime();
        const timeB = new Date(b.updatedAt || b.createdAt).getTime();
        return timeB - timeA;
      });

      let bestMatch: Submission | undefined = undefined;
      let highestConfidence = 0;

      for (const sub of migrated) {
        const matchResult = matchForm(hostname, fields, sub);
        if (matchResult.isMatch && matchResult.confidence > highestConfidence) {
          highestConfidence = matchResult.confidence;
          bestMatch = sub;
          if (highestConfidence >= 1.0) {
            break; // Perfect match found
          }
        }
      }

      return bestMatch;
    },
  };
}
