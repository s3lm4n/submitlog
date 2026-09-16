import { openDB, type IDBPDatabase, type DBSchema } from 'idb';
import type { Submission } from '../models/submission';

const DB_NAME = 'submitlog';
const DB_VERSION = 1;
const STORE_NAME = 'submissions';

interface SubmitLogDB extends DBSchema {
  submissions: {
    key: string;
    value: Submission;
    indexes: {
      'by-created': string;
      'by-hostname': string;
    };
  };
}

let dbPromise: Promise<IDBPDatabase<SubmitLogDB>> | null = null;

export async function getDB(): Promise<IDBPDatabase<SubmitLogDB>> {
  if (!dbPromise) {
    dbPromise = openDB<SubmitLogDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
          store.createIndex('by-created', 'createdAt');
          store.createIndex('by-hostname', 'hostname');
        }
      },
    });
  }
  return dbPromise;
}
