// The Articles browse's batch, kept for the DAY. The browse is a random draw from
// Wikinews, and the host (Learn) unmounts it whenever a quiz takes the tab — so without
// this, stepping into a quiz and back threw away the articles the user was looking at.
//
// A batch is kept per user + wiki + language + topic + LOCAL calendar day, until Refresh replaces
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

/** The identity a kept batch is valid for. Local date, so "daily" is the user's day.
 *  A `topic` gets its own batch; none (or "all") is the whole-wiki draw. */
export function browseKey(p: { userId: string; site: WikiSite; lang: string; topic?: string; now?: Date }): string {
  const d = p.now ?? new Date();
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const base = `${p.userId}|${p.site}|${p.lang}|${day}`;
  return p.topic && p.topic !== "all" ? `${base}|${p.topic}` : base;
}

interface Kept {
  key: string;
  items: Headline[];
}

/** user|site|lang|day — what every topic's batch for one day shares. */
const dayOf = (key: string) => key.split("|").slice(0, 4).join("|");

// One batch per TOPIC for the current day: switching topic and back shows the same
// stories, like leaving the tab and coming back does. Anything from another day, user
// or language is dropped on the next write, so this never grows past a day's topics.
let memory: Kept[] | null = null;

function stored(): Kept[] {
  if (memory) return memory;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    // A single { key, items } is the shape from before topics existed.
    const list = Array.isArray(parsed) ? parsed : [parsed];
    memory = list.filter(
      (k): k is Kept => !!k && typeof k.key === "string" && Array.isArray(k.items),
    );
  } catch {
    memory = [];
  }
  return memory;
}

/** The batch kept for `key`, or null (none, another day/user/language, unreadable). */
export function readBrowse(key: string): Headline[] | null {
  return stored().find((k) => k.key === key)?.items ?? null;
}

/** Keep `items` as the batch for `key` (replacing whatever was kept for it before). */
export function writeBrowse(key: string, items: Headline[]): void {
  const day = dayOf(key);
  memory = [...stored().filter((k) => k.key !== key && dayOf(k.key) === day), { key, items }];
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
