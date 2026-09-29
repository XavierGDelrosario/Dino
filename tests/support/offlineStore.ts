// An in-memory OfflineStore for tests — the pure queue is written against the interface,
// and src/services/offline/store.ts's __setOfflineStore seam swaps it in.
import type { OfflineStore } from "@/services/offline/store";

export function memStore(): OfflineStore {
  const m = new Map<string, unknown>();
  return {
    get: async <T,>(k: string) => (m.has(k) ? (m.get(k) as T) : null),
    set: async <T,>(k: string, v: T) => void m.set(k, v),
    del: async (k: string) => void m.delete(k),
  };
}
