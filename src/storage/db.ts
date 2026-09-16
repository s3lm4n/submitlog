import { openDB, type IDBPDatabase, type DBSchema } from 'idb';
import type { Submission } from '../models/submission';
import type { FormDraft } from '../models/draft';

import type { AnswerMemoryEntry } from './answer-memory-repository';

const DB_NAME = 'submitlog';
const DB_VERSION = 4;
const STORE_SUBMISSIONS = 'submissions';
const STORE_DRAFTS = 'drafts';
const STORE_ANSWERS = 'answer_memory';

export interface SubmitLogDB extends DBSchema {
  submissions: {
    key: string;
    value: Submission;
    indexes: {
      'by-created': string;
      'by-hostname': string;
      'by-fingerprint': string;
    };
  };
  drafts: {
    key: string;
    value: FormDraft;
    indexes: {
      'by-origin': string;
      'by-hostname': string;
      'by-updated': string;
    };
  };
  answer_memory: {
    key: string;
    value: AnswerMemoryEntry;
    indexes: {
      'by-label': string;
      'by-hostname': string;
      'by-updated': string;
    };
  };
}

let dbPromise: Promise<IDBPDatabase<SubmitLogDB>> | null = null;

export async function getDB(): Promise<IDBPDatabase<SubmitLogDB>> {
  if (!dbPromise) {
    dbPromise = openDB<SubmitLogDB>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion, newVersion, transaction) {
        let subStore;
        if (!db.objectStoreNames.contains(STORE_SUBMISSIONS)) {
          subStore = db.createObjectStore(STORE_SUBMISSIONS, { keyPath: 'id' });
          subStore.createIndex('by-created', 'createdAt');
          subStore.createIndex('by-hostname', 'hostname');
          subStore.createIndex('by-fingerprint', 'formFingerprint');
        } else {
          subStore = transaction.objectStore(STORE_SUBMISSIONS);
          if (!subStore.indexNames.contains('by-fingerprint')) {
            subStore.createIndex('by-fingerprint', 'formFingerprint');
          }
        }

        if (!db.objectStoreNames.contains(STORE_DRAFTS)) {
          const draftStore = db.createObjectStore(STORE_DRAFTS, { keyPath: 'id' });
          draftStore.createIndex('by-origin', 'origin');
          draftStore.createIndex('by-hostname', 'hostname');
          draftStore.createIndex('by-updated', 'updatedAt');
        }

        if (!db.objectStoreNames.contains(STORE_ANSWERS)) {
          const answerStore = db.createObjectStore(STORE_ANSWERS, { keyPath: 'id' });
          answerStore.createIndex('by-label', 'normalizedLabel');
          answerStore.createIndex('by-hostname', 'hostname');
          answerStore.createIndex('by-updated', 'updatedAt');
        }
      },
    });
  }
  return dbPromise;
}

export function closeDB(): void {
  if (dbPromise) {
    dbPromise.then((db) => db.close()).catch(() => {});
    dbPromise = null;
  }
}
