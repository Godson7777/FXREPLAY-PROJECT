import type { Bars, DatasetMeta } from '../core/types';

/** Tiny promise wrapper around IndexedDB. Everything stays in the user's browser. */
const DB_NAME = 'overflowtrade';
const DB_VER = 1;
let dbp: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = () => {
        const d = req.result;
        for (const s of ['meta', 'bars', 'sessions', 'shots', 'kv']) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbp;
}

async function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const r = fn(t.objectStore(store));
    t.oncomplete = () => resolve(r.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const idb = {
  get: <T>(store: string, key: string) => tx<T>(store, 'readonly', (s) => s.get(key) as IDBRequest<T>),
  put: (store: string, key: string, val: unknown) => tx(store, 'readwrite', (s) => s.put(val, key)),
  del: (store: string, key: string) => tx(store, 'readwrite', (s) => s.delete(key)),
  all: <T>(store: string) => tx<T[]>(store, 'readonly', (s) => s.getAll() as IDBRequest<T[]>),
};

// ---- datasets --------------------------------------------------------------

interface StoredBars {
  t: ArrayBuffer; o: ArrayBuffer; h: ArrayBuffer; l: ArrayBuffer; c: ArrayBuffer; v: ArrayBuffer; n: number;
}

export async function saveDataset(meta: DatasetMeta, bars: Bars) {
  const sb: StoredBars = {
    t: bars.t.slice(0, bars.n).buffer, o: bars.o.slice(0, bars.n).buffer, h: bars.h.slice(0, bars.n).buffer,
    l: bars.l.slice(0, bars.n).buffer, c: bars.c.slice(0, bars.n).buffer, v: bars.v.slice(0, bars.n).buffer, n: bars.n,
  };
  await idb.put('bars', meta.id, sb);
  await idb.put('meta', meta.id, meta);
  barCache.delete(meta.id);
}

const barCache = new Map<string, Bars>();

export async function loadBars(id: string): Promise<Bars | null> {
  const c = barCache.get(id);
  if (c) return c;
  const sb = await idb.get<StoredBars>('bars', id);
  if (!sb) return null;
  const b: Bars = {
    t: new Float64Array(sb.t), o: new Float64Array(sb.o), h: new Float64Array(sb.h),
    l: new Float64Array(sb.l), c: new Float64Array(sb.c), v: new Float64Array(sb.v), n: sb.n,
  };
  barCache.set(id, b);
  return b;
}

export const listDatasets = () => idb.all<DatasetMeta>('meta').then((m) => m.sort((a, b) => a.symbol.localeCompare(b.symbol)));
export const getDatasetMeta = (id: string) => idb.get<DatasetMeta>('meta', id);

export async function deleteDataset(id: string) {
  barCache.delete(id);
  await idb.del('bars', id);
  await idb.del('meta', id);
}

export async function updateDatasetMeta(meta: DatasetMeta) {
  await idb.put('meta', meta.id, meta);
}
