import type { ProjectConfig, SimResult, StoredProject } from '../types';

const DB_NAME = 'ess-thermal-sim';
const DB_VERSION = 1;
const STORE = 'projects';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'config.id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then((db) => new Promise<T>((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    req.onsuccess = () => { resolve(req.result); db.close(); };
    req.onerror = () => { reject(req.error); db.close(); };
  }));
}

export async function saveProject(config: ProjectConfig): Promise<void> {
  const existing = await getProject(config.id).catch(() => null);
  const record: StoredProject = existing ?? { config, results: [] };
  record.config = config;
  await tx('readwrite', (s) => s.put(record));
}

export async function getProject(id: string): Promise<StoredProject | undefined> {
  return tx('readonly', (s) => s.get(id) as IDBRequest<StoredProject | undefined>);
}

export async function listProjects(): Promise<{ id: string; name: string; createdAt: number; resultCount: number }[]> {
  const all = await tx('readonly', (s) => s.getAll() as IDBRequest<StoredProject[]>);
  return all.map((p) => ({ id: p.config.id, name: p.config.name, createdAt: p.config.createdAt, resultCount: p.results.length }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

export async function deleteProject(id: string): Promise<void> {
  await tx('readwrite', (s) => s.delete(id));
}

export async function saveResult(projectId: string, result: SimResult): Promise<void> {
  const record = await getProject(projectId);
  if (!record) throw new Error('方案不存在: ' + projectId);
  record.results.unshift(result);
  if (record.results.length > 10) record.results.length = 10; // 每方案最多留 10 次
  await tx('readwrite', (s) => s.put(record));
}

export async function listResults(projectId: string): Promise<SimResult[]> {
  const record = await getProject(projectId);
  return record?.results ?? [];
}
