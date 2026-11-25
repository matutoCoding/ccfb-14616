import type { RunSummary, Scheme } from './types';

const DB_NAME = 'ess-thermal-studio';
const DB_VERSION = 1;
const STORE_SCHEMES = 'schemes';
const STORE_RUNS = 'runs';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('当前环境没有 IndexedDB'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_SCHEMES)) db.createObjectStore(STORE_SCHEMES, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORE_RUNS)) {
        const store = db.createObjectStore(STORE_RUNS, { keyPath: 'id' });
        store.createIndex('schemeId', 'schemeId', { unique: false });
        store.createIndex('createdAt', 'createdAt', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(storeName: string, mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then((db) => new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const request = fn(transaction.objectStore(storeName));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }));
}

export async function idbGetAllSchemes(): Promise<Scheme[]> {
  try {
    return await tx(STORE_SCHEMES, 'readonly', (s) => s.getAll() as IDBRequest<Scheme[]>);
  } catch {
    return [];
  }
}

export async function idbPutScheme(scheme: Scheme): Promise<void> {
  await tx(STORE_SCHEMES, 'readwrite', (s) => s.put(scheme) as IDBRequest<IDBValidKey>);
}

export async function idbDeleteScheme(id: string): Promise<void> {
  await tx(STORE_SCHEMES, 'readwrite', (s) => s.delete(id) as IDBRequest<undefined>);
}

export async function idbGetAllRuns(): Promise<RunSummary[]> {
  try {
    const runs = await tx(STORE_RUNS, 'readonly', (s) => s.getAll() as IDBRequest<RunSummary[]>);
    // List views do not need multi-megabyte frame blobs. Keep the stored
    // records intact and lazily load the selected run via idbGetRun.
    for (const run of runs) delete run.frames;
    return runs.sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    return [];
  }
}

export async function idbGetRun(id: string): Promise<RunSummary | undefined> {
  return tx(STORE_RUNS, 'readonly', (s) => s.get(id) as IDBRequest<RunSummary | undefined>);
}

export async function idbPutRun(run: RunSummary): Promise<void> {
  await tx(STORE_RUNS, 'readwrite', (s) => s.put(run) as IDBRequest<IDBValidKey>);
}

export async function idbDeleteRun(id: string): Promise<void> {
  await tx(STORE_RUNS, 'readwrite', (s) => s.delete(id) as IDBRequest<undefined>);
}

export async function idbClearRuns(): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE_RUNS, 'readwrite');
    transaction.objectStore(STORE_RUNS).clear();
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}
