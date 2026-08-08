// The ONE place offline data touches a platform API.
//
// Everything above this file (clock, queue, sync) is pure and platform-neutral, so the
// iOS and web shells differ only here — the same split `analyze()` uses for the
// morphological engine.
//
// Web uses IndexedDB, not localStorage: the pending-grade queue is the only copy of
// work the user has already done, and localStorage is synchronous, ~5 MB, and cleared
// by "clear site data" alongside caches. IndexedDB is none of those things.
//
// Native (Capacitor) currently falls through to the same IndexedDB path, which works in
// WKWebView. Swapping in @capacitor/preferences (or SQLite) is a change to `backend()`
// alone; nothing above needs to know.

const DB_NAME = "dino-offline";
const STORE = "kv";
const DB_VERSION = 1;

export interface OfflineStore {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  del(key: string): Promise<void>;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  const opened = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).catch((e: unknown) => {
    dbPromise = null; // let a later call retry rather than caching the failure
    throw e;
  });
  dbPromise = opened;
  return opened;
}

function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const request = run(db.transaction(STORE, mode).objectStore(STORE));
        request.onsuccess = () => resolve(request.result as T);
        request.onerror = () => reject(request.error);
      }),
  );
}

const indexedDbStore: OfflineStore = {
  get: <T,>(key: string) => tx<T | undefined>("readonly", (s) => s.get(key)).then((v) => v ?? null),
  set: <T,>(key: string, value: T) => tx<unknown>("readwrite", (s) => s.put(value, key)).then(() => {}),
  del: (key: string) => tx<unknown>("readwrite", (s) => s.delete(key)).then(() => {}),
};

/**
 * In-memory fallback for a runtime with no IndexedDB (SSR, some test environments).
 *
 * DELIBERATELY NOT DURABLE, and that is the honest behaviour: pretending to persist
 * would lose a user's grades silently. `isDurable()` lets a caller refuse to accept
 * offline work it cannot promise to keep.
 */
function memoryStore(): OfflineStore {
  const m = new Map<string, unknown>();
  return {
    get: async <T,>(k: string) => (m.has(k) ? (m.get(k) as T) : null),
    set: async <T,>(k: string, v: T) => void m.set(k, v),
    del: async (k: string) => void m.delete(k),
  };
}

const hasIndexedDb = typeof indexedDB !== "undefined";
let backend: OfflineStore = hasIndexedDb ? indexedDbStore : memoryStore();

/** False when offline work cannot survive a reload — callers should not promise it. */
export function isDurable(): boolean {
  return hasIndexedDb;
}

export function offlineStore(): OfflineStore {
  return backend;
}

/** TEST SEAM: swap the backend (mirrors __clearWordsCache / __resetDictionaryColumnProbe). */
export function __setOfflineStore(s: OfflineStore): void {
  backend = s;
}

export function __resetOfflineStore(): void {
  backend = hasIndexedDb ? indexedDbStore : memoryStore();
}
