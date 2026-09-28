// The Articles browse's batch, kept for the DAY. The browse is a random draw from
// Wikinews, and the host (Learn) unmounts it whenever a quiz takes the tab — so without
// this, stepping into a quiz and back threw away the articles the user was looking at.
//
// A batch is kept per user + wiki + language + LOCAL calendar day, until Refresh replaces
// it or the day turns. Why not a seeded hash? Wikinews' random generator takes no seed
// and the API has no offset into its article list, so a seed can't reproduce a batch —
// remembering the batch is how "the same articles all day, different per user" is done.
//
// Two layers: a module-level copy (survives the host unmounting the view) and
// localStorage (survives an app restart the same day). Storage is best-effort — it can
// be missing, full or blocked, and every access is guarded; the fallback is simply a
// fresh draw, which is the old behaviour.
import type { Headline, WikiSite } from "./mediawiki";

const STORAGE_KEY = "dino.media.browse";

/** The identity a kept batch is valid for. Local date, so "daily" is the user's day. */
export function browseKey(p: { userId: string; site: WikiSite; lang: string; now?: Date }): string {
  const d = p.now ?? new Date();
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return `${p.userId}|${p.site}|${p.lang}|${day}`;
}

interface Kept {
  key: string;
  items: Headline[];
}

let memory: Kept | null = null;

/** The batch kept for `key`, or null (none, another day/user/language, unreadable). */
export function readBrowse(key: string): Headline[] | null {
  if (memory?.key === key) return memory.items;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const kept = JSON.parse(raw) as Kept;
    if (kept?.key !== key || !Array.isArray(kept.items)) return null;
    memory = kept;
    return kept.items;
  } catch {
    return null;
  }
}

/** Keep `items` as the batch for `key` (replacing whatever was kept before). */
export function writeBrowse(key: string, items: Headline[]): void {
  memory = { key, items };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(memory));
  } catch {
    // Storage full / blocked: the in-memory copy still covers this session.
  }
}

/** Test seam: forget the in-memory copy. */
export function __resetBrowseMemory(): void {
  memory = null;
}
