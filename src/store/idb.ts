// IndexedDB 持久化：projects / runs 两个对象仓库
import type { ProjectConfig, SimulationRun } from '../model/types';

const DB_NAME = 'ess-thermal-sim';
const DB_VERSION = 1;
const STORES = { projects: 'projects', runs: 'runs' } as const;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORES.projects)) {
        db.createObjectStore(STORES.projects, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORES.runs)) {
        const s = db.createObjectStore(STORES.runs, { keyPath: 'id' });
        s.createIndex('projectId', 'projectId', { unique: false });
        s.createIndex('createdAt', 'createdAt', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then((db) => new Promise<T>((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

export const idb = {
  async saveProject(p: ProjectConfig): Promise<void> {
    await tx(STORES.projects, 'readwrite', (s) => s.put({ ...p, updatedAt: Date.now() }));
  },
  async loadProject(id: string): Promise<ProjectConfig | undefined> {
    return tx<ProjectConfig | undefined>(STORES.projects, 'readonly', (s) => s.get(id));
  },
  async listProjects(): Promise<ProjectConfig[]> {
    const all = await tx<ProjectConfig[]>(STORES.projects, 'readonly', (s) => s.getAll() as IDBRequest<ProjectConfig[]>);
    return all.sort((a, b) => b.updatedAt - a.updatedAt);
  },
  async deleteProject(id: string): Promise<void> {
    await tx(STORES.projects, 'readwrite', (s) => s.delete(id));
    const runs = await this.listRuns(id);
    for (const r of runs) await this.deleteRun(r.id);
  },
  async saveRun(r: SimulationRun): Promise<void> {
    await tx(STORES.runs, 'readwrite', (s) => s.put(r));
  },
  async listRuns(projectId?: string): Promise<SimulationRun[]> {
    const db = await openDb();
    return new Promise<SimulationRun[]>((resolve, reject) => {
      const t = db.transaction(STORES.runs, 'readonly');
      const store = t.objectStore(STORES.runs);
      const req = projectId ? store.index('projectId').getAll(projectId) : store.getAll();
      req.onsuccess = () => {
        const rows = (req.result as SimulationRun[]).sort((a, b) => b.createdAt - a.createdAt);
        // 列表不携带大快照，页面回放时再整条加载
        resolve(rows.map((r) => ({ ...r, tempFrames: [], stateFrames: [] })));
      };
      req.onerror = () => reject(req.error);
    });
  },
  async loadRun(id: string): Promise<SimulationRun | undefined> {
    return tx<SimulationRun | undefined>(STORES.runs, 'readonly', (s) => s.get(id));
  },
  async deleteRun(id: string): Promise<void> {
    await tx(STORES.runs, 'readwrite', (s) => s.delete(id));
  },
};
