// Fills the vocabulary cache (vocabularyCache.ts). Two shapes:
//
// COLD (nothing complete yet): ALL streams straight into the live store — a 100-row
// first page so the table paints at once, then 1000-row pages behind it — while the
// list membership and the lists load in parallel. Was: 100-row pages for the whole
// load, and again on every list switch.
//
// RE-CHECK (complete, but older than VOCABULARY_TTL_MS): the cached copy stays on
// screen while a full snapshot loads off to the side, then swaps in — unless a write
// landed meanwhile (see replaceIfUnchanged). This only exists for changes made on
// ANOTHER device or tab; this device's writes are already in the cache.
//
// One load per user at a time: callers share the in-flight promise.

import { listUserLists } from "../lists";
import {
  getAllUserWords,
  getListMembership,
  USER_WORDS_BULK_PAGE_SIZE,
  USER_WORDS_PAGE_SIZE,
  type UserWord,
} from "./userWords";
import {
  appendPage,
  isFresh,
  markComplete,
  replaceIfUnchanged,
  setLists,
  setMembership,
  startFresh,
  wasLoaded,
  writesSoFar,
} from "./vocabularyCache";

const inflight = new Map<string, Promise<void>>();

/**
 * Make sure `userId`'s vocabulary is loaded. Resolves at once when the cache is fresh;
 * otherwise loads (cold) or re-checks (stale). A re-check never rejects — the cached
 * copy is still good to show — so a rejection always means a cold load failed.
 */
export function ensureVocabulary(userId: string): Promise<void> {
  if (isFresh(userId)) return Promise.resolve();
  const running = inflight.get(userId);
  if (running) return running;
  const p = (wasLoaded(userId) ? recheck(userId) : coldLoad(userId)).finally(() =>
    inflight.delete(userId),
  );
  inflight.set(userId, p);
  return p;
}

/** Every row of ALL, newest first, in as few requests as the max-rows cap allows. */
async function pageAll(userId: string, onPage: (page: UserWord[]) => void): Promise<void> {
  const first = await getAllUserWords({ userId, offset: 0, limit: USER_WORDS_PAGE_SIZE });
  onPage(first);
  if (first.length < USER_WORDS_PAGE_SIZE) return;
  for (let offset = first.length; ; offset += USER_WORDS_BULK_PAGE_SIZE) {
    const page = await getAllUserWords({ userId, offset, limit: USER_WORDS_BULK_PAGE_SIZE });
    onPage(page);
    if (page.length < USER_WORDS_BULK_PAGE_SIZE) return;
  }
}

async function coldLoad(userId: string): Promise<void> {
  startFresh(userId);

  const lists = listUserLists(userId).then((ls) => setLists(userId, ls));
  const membership = getListMembership().then((m) => setMembership(userId, m));
  const words = pageAll(userId, (page) => appendPage(userId, page)).then(() => markComplete(userId));
  await Promise.all([words, lists, membership]);
}

async function recheck(userId: string): Promise<void> {
  const writes = writesSoFar(userId);
  try {
    const collected: UserWord[] = [];
    const [membership, lists] = await Promise.all([
      getListMembership(),
      listUserLists(userId),
      pageAll(userId, (page) => collected.push(...page)),
    ]);
    replaceIfUnchanged(userId, writes, { words: collected, membership, lists });
  } catch (e) {
    // The cached copy is still what this device last saw — keep showing it.
    console.warn("vocabulary re-check failed", e);
  }
}
