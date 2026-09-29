// Session cache of the user's VOCABULARY: every `user_words` row (= ALL), which list
// each one is tagged into, and the lists themselves.
//
// WHY: the Lists tab used to re-stream the whole selected list on every chip switch and
// every return to the tab — 100 rows a request, one after another, so a 1,000-word ALL
// was 11 round trips each time. With this, a session pays for the vocabulary ONCE and
// switching lists is a client-side filter: every list's words are a subset of ALL, so
// "words in list X" is ALL filtered by X's membership, no request needed.
//
// WHY IT CAN'T GO STALE ON THIS DEVICE — WRITE-THROUGH, NOT INVALIDATION. `user_words`
// mutates constantly (saves in Translate, grades in Review and every quiz, "Forgot",
// edits, tags), which is why it used to stay live-read. The fix is that every service
// that WRITES it also updates this cache with what the server returned: userWords.ts
// (save / create / edit / delete / tag / untag), review.ts (record_review and
// soften_confidence return the full row) and lists.ts (create / rename / delete). All
// vocabulary writes go through those three files, so a write from any tab lands here.
// Writes from ANOTHER device or browser tab can't reach it; the TTL below is the
// backstop for that.
//
// CONFIDENCE IS RECOMPUTED ON READ. The displayed 0–5 decays with time, so a cached
// number would drift from the one Review shows. Each word keeps its raw inputs
// (`confidenceInputs`) and `wordsFor` re-derives `confidenceRating` at read time with
// the same `displayConfidence` every other surface uses.
//
// One user at a time: a different userId simply starts a fresh store. Nothing here
// outlives a page reload.

import { displayConfidence } from "../confidence";
import type { List, ListOverview } from "../lists";
import type { UserWord } from "./userWords";

/** How long a complete load is trusted before it is re-checked in the background.
 *  Only covers writes made elsewhere (another device or tab); this device's writes
 *  are applied the moment they succeed. */
export const VOCABULARY_TTL_MS = 10 * 60_000;

interface Store {
  userId: string;
  /** ALL, newest first (the order the server returns it). */
  order: string[];
  entries: Map<string, UserWord>;
  /** Every page of ALL has arrived. */
  complete: boolean;
  /** listId → the userWordIds tagged into it. null until loaded. */
  membership: Map<string, Set<string>> | null;
  lists: List[] | null;
  /** When the last full load finished (ms). 0 = never. */
  loadedAt: number;
  /** Words deleted since the current load began — a later page must not bring them back. */
  deleted: Set<string>;
  /** Tag ops made before membership arrived, replayed onto it when it does. */
  pendingTags: Array<{ op: "tag" | "untag"; listId: string; ids: string[] }>;
  /** Bumped on every change; subscribers and memoized reads key on it. */
  version: number;
  /** Bumped by WRITES only (not by loading) — a background re-check that sees it move
   *  knows its snapshot may predate a local write, and keeps the live store instead. */
  writes: number;
  /** The Lists overview (list_overview RPC), valid while `writes` hasn't moved. */
  overview: { rows: ListOverview[]; writes: number; at: number } | null;
}

let store: Store | null = null;
const listeners = new Set<() => void>();

type Pair = { listId: string; userWordId: string };

function fresh(userId: string): Store {
  return {
    userId,
    order: [],
    entries: new Map(),
    complete: false,
    membership: null,
    lists: null,
    loadedAt: 0,
    deleted: new Set(),
    pendingTags: [],
    version: 0,
    writes: 0,
    overview: null,
  };
}

function notify(): void {
  for (const fn of listeners) fn();
}

function emit(s: Store, write: boolean): void {
  s.version++;
  if (write) s.writes++;
  notify();
}

/** The store for `userId`, creating (or replacing another user's) on demand. */
export function vocabularyStore(userId: string): Store {
  if (!store || store.userId !== userId) store = fresh(userId);
  return store;
}

/** An EMPTY store for `userId` — the start of a cold load (a half-finished earlier one
 *  can't be resumed: offsets shift under writes). */
export function startFresh(userId: string): void {
  store = fresh(userId);
  notify();
}

/** The store only if it already belongs to `userId` — write-through never creates one.
 *  No userId = whoever's store it is (a write keyed by row id belongs to the signed-in
 *  user, whose store this is). */
function current(userId?: string): Store | null {
  if (!store) return null;
  return userId === undefined || store.userId === userId ? store : null;
}

/** Everything a full load brings: every page of ALL, the membership and the lists. */
function isLoaded(s: Store): boolean {
  return s.complete && s.membership !== null && s.lists !== null;
}

export function subscribeVocabulary(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Changes whenever anything in the store does — the useSyncExternalStore snapshot. */
export function vocabularyVersion(): number {
  return store?.version ?? -1;
}

// ── Reads ─────────────────────────────────────────────────────────────────────

/** Nothing has to be fetched to show `listId` (null = ALL) right now. */
export function isReadable(userId: string, listId: string | null): boolean {
  const s = current(userId);
  if (!s || !s.complete) return false;
  return listId === null || s.membership !== null;
}

/** Fully loaded, and young enough that no re-check is due. */
export function isFresh(userId: string, now = Date.now()): boolean {
  const s = current(userId);
  return !!s && isLoaded(s) && now - s.loadedAt < VOCABULARY_TTL_MS;
}

/** Fully loaded at some point (possibly stale) — the loader re-checks rather than reloads. */
export function wasLoaded(userId: string): boolean {
  const s = current(userId);
  return !!s && isLoaded(s);
}

/** Has at least the first page of ALL. */
export function hasWords(userId: string): boolean {
  const s = current(userId);
  return !!s && (s.order.length > 0 || s.complete);
}

/** Confidence moves slowly; a word re-derived within the same minute is reused, so an
 *  unchanged word keeps its object identity across reads (only what changed is new). */
const DERIVE_BUCKET_MS = 60_000;
const derived = new WeakMap<UserWord, { bucket: number; word: UserWord }>();

function withLiveConfidence(w: UserWord, now: number): UserWord {
  if (!w.confidenceInputs) return w;
  const bucket = Math.floor(now / DERIVE_BUCKET_MS);
  const hit = derived.get(w);
  if (hit && hit.bucket === bucket) return hit.word;
  const word = { ...w, confidenceRating: displayConfidence(w.confidenceInputs, now) };
  derived.set(w, { bucket, word });
  return word;
}

const NO_IDS: ReadonlySet<string> = new Set();

/**
 * The words of `listId` (null = ALL), newest first, with confidence re-derived at
 * `now`. A list whose membership hasn't loaded yet reads as empty.
 */
export function wordsFor(userId: string, listId: string | null, now = Date.now()): UserWord[] {
  const s = current(userId);
  if (!s || (listId !== null && !s.membership)) return [];
  const inList = listId === null ? null : s.membership!.get(listId) ?? NO_IDS;
  const out: UserWord[] = [];
  for (const id of s.order) {
    if (inList && !inList.has(id)) continue;
    const w = s.entries.get(id);
    if (w) out.push(withLiveConfidence(w, now));
  }
  return out;
}

export function cachedLists(userId: string): List[] | null {
  return current(userId)?.lists ?? null;
}

/** The Lists overview as last fetched — null once any vocabulary write (from any tab)
 *  could have changed its counts or dates, or after the TTL. */
export function cachedOverview(now = Date.now()): ListOverview[] | null {
  const s = current();
  const o = s?.overview;
  if (!s || !o || o.writes !== s.writes || now - o.at >= VOCABULARY_TTL_MS) return null;
  return o.rows;
}

export function rememberOverview(rows: ListOverview[]): void {
  const s = current();
  if (s) s.overview = { rows, writes: s.writes, at: Date.now() };
}

// ── Loading (called by vocabularyLoader) ───────────────────────────────────────

function addEntries(s: Store, page: UserWord[]): void {
  for (const w of page) {
    if (s.entries.has(w.userWordId) || s.deleted.has(w.userWordId)) continue;
    s.entries.set(w.userWordId, w);
    s.order.push(w.userWordId);
  }
}

function buildMembership(s: Store, pairs: Pair[]): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  for (const p of pairs) {
    if (s.deleted.has(p.userWordId)) continue;
    let set = m.get(p.listId);
    if (!set) m.set(p.listId, (set = new Set()));
    set.add(p.userWordId);
  }
  return m;
}

/** Append a page of ALL during a load, skipping words already present or deleted. */
export function appendPage(userId: string, page: UserWord[]): void {
  const s = current(userId);
  if (!s) return;
  addEntries(s, page);
  emit(s, false);
}

export function markComplete(userId: string): void {
  const s = current(userId);
  if (!s) return;
  s.complete = true;
  s.loadedAt = Date.now();
  emit(s, false);
}

/** Install the membership map, then replay tag ops that raced it. */
export function setMembership(userId: string, pairs: Pair[]): void {
  const s = current(userId);
  if (!s) return;
  s.membership = buildMembership(s, pairs);
  for (const t of s.pendingTags) applyTag(s, t.op, t.listId, t.ids);
  s.pendingTags = [];
  emit(s, false);
}

export function setLists(userId: string, lists: List[]): void {
  const s = current(userId);
  if (!s) return;
  s.lists = lists;
  emit(s, false);
}

/**
 * Swap in a complete background re-check — UNLESS a local write landed while it was
 * in flight (its snapshot may predate that write, and the live store already has it).
 * Returns whether the snapshot was used. One notification either way.
 */
export function replaceIfUnchanged(
  userId: string,
  writesAtStart: number,
  snapshot: { words: UserWord[]; membership: Pair[]; lists: List[] },
): boolean {
  const s = current(userId);
  if (!s) return false;
  if (s.writes !== writesAtStart) {
    s.loadedAt = Date.now(); // this device's view is current; re-check next TTL
    return false;
  }
  const next = fresh(userId);
  addEntries(next, snapshot.words);
  next.membership = buildMembership(next, snapshot.membership);
  next.lists = snapshot.lists;
  next.complete = true;
  next.loadedAt = Date.now();
  next.version = s.version;
  next.writes = s.writes;
  store = next;
  emit(next, false);
  return true;
}

export function writesSoFar(userId: string): number {
  return current(userId)?.writes ?? 0;
}

/** Drop the cache — a sign-out / account switch, or `userId`'s store only. */
export function resetVocabulary(userId?: string): void {
  if (userId === undefined || store?.userId === userId) store = null;
  notify();
}

// ── Write-through (called by the services after a successful write) ───────────

/** Tag or untag — onto the membership, or queued until it has loaded. */
function applyTag(s: Store, op: "tag" | "untag", listId: string, ids: string[]): void {
  if (!s.membership) {
    s.pendingTags.push({ op, listId, ids });
    return;
  }
  let set = s.membership.get(listId);
  if (op === "tag") {
    if (!set) s.membership.set(listId, (set = new Set()));
    for (const id of ids) if (s.entries.has(id) || !s.complete) set.add(id);
  } else if (set) {
    for (const id of ids) set.delete(id);
  }
}

/**
 * Newly saved / created words go to the top (newest first); `listId` tags them too
 * (the save RPCs tag atomically). A word ALREADY cached is left as it is: re-saving is
 * a server-side no-op that keeps its history, and the save response lacks the joined
 * dictionary fields and ignores a meaning override, so the cached entry is the better
 * copy. (An edit, which does change it, patches by id — writeWordById.)
 */
export function writeWords(userId: string, words: UserWord[], listId?: string): void {
  const s = current(userId);
  if (!s || words.length === 0) return;
  const added: string[] = [];
  for (const w of words) {
    s.deleted.delete(w.userWordId);
    if (s.entries.has(w.userWordId)) continue;
    s.entries.set(w.userWordId, w);
    added.push(w.userWordId);
  }
  if (added.length) s.order = [...added, ...s.order];
  if (listId) applyTag(s, "tag", listId, words.map((w) => w.userWordId));
  emit(s, true);
}

/** Patch one cached word by id: an edit (the full joined row), or a review / "Forgot"
 *  (the new schedule + confidence inputs, no dictionary fields). */
export function writeWordById(userWordId: string, patch: Partial<UserWord>): void {
  const s = current();
  const prev = s?.entries.get(userWordId);
  if (!s || !prev) return;
  s.entries.set(userWordId, { ...prev, ...patch });
  emit(s, true);
}

export function removeWord(userWordId: string): void {
  const s = current();
  if (!s) return;
  s.deleted.add(userWordId);
  s.entries.delete(userWordId);
  s.order = s.order.filter((id) => id !== userWordId);
  s.membership?.forEach((set) => set.delete(userWordId)); // list_words cascades
  emit(s, true);
}

export function retagInCache(op: "tag" | "untag", listId: string, userWordIds: string[]): void {
  const s = current();
  if (!s || userWordIds.length === 0) return;
  applyTag(s, op, listId, userWordIds);
  emit(s, true);
}

const byName = (a: List, b: List) => a.listName.localeCompare(b.listName);

export function listCreated(userId: string, list: List): void {
  const s = current(userId);
  if (!s || !s.lists) return;
  if (!s.lists.some((l) => l.listId === list.listId)) s.lists = [...s.lists, list].sort(byName);
  emit(s, true);
}

export function listRenamed(listId: string, listName: string): void {
  const s = current();
  if (!s || !s.lists) return;
  s.lists = s.lists.map((l) => (l.listId === listId ? { ...l, listName } : l)).sort(byName);
  emit(s, true);
}

/** A deleted list: its tags cascade away; the words stay in ALL. */
export function listDeleted(listId: string): void {
  const s = current();
  if (!s) return;
  s.lists = s.lists?.filter((l) => l.listId !== listId) ?? null;
  s.membership?.delete(listId);
  emit(s, true);
}
