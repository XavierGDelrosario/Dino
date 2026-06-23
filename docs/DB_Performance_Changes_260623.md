# DB & Cache Performance Changes — 2026-06-23

A pass over the read/write hot paths to cut round-trips: a client-side read cache,
request-level batching (reads, writes, and the edge translate call), the review
queue moved into SQL, plus a few low-risk frontend/index wins. No behavior change —
same results, fewer round-trips.

**Guiding split:** the global `words` dictionary (verified, read-only to clients,
effectively immutable in a session) is safe to cache and batch aggressively;
`user_words` (a user's vocabulary + mastery, mutated constantly) is deliberately
**not** cached — those reads stay live.

**Verification:** `tsc` clean, 177 unit tests pass, `vite build` green. The one
path Vitest can't execute is the Deno **edge function handler** (batch I/O,
`fetchVerifiedMany`'s `or(input.in.…,input_reading.in.…)`); its pure helpers and
every client wrapper are unit-tested, but the handler itself needs a live
`supabase functions serve translate` check. The new SQL functions + index apply on
the next `supabase db reset` and are covered by the gated integration suite.

---

## Summary

| Path | Before | After |
|---|---|---|
| Repeat word lookup (same session) | DB round-trip every time | served from in-memory `Map` (0 round-trips) |
| EN→JA single-word lookup (8 candidates, cold) | ~18 round-trips (1 + 8 DB + 8 edge) | ~4 (1 DB + 1 edge for the fan-out) |
| Paragraph with N uncached words | N edge calls (6 concurrent) | **1** batched edge call |
| Cold word persist (edge) | upsert **+ re-read** | `upsert().select()` (no re-read) |
| "Add all" of N words | N save RPCs | **1** batched RPC |
| Review queue (20 cards) | fetch **entire** vocabulary, rank in JS | DB ranks + `LIMIT`, ≤20 rows on the wire |
| Initial JS bundle | 405.6 KB (115 KB gz) | 362.3 KB (104 KB gz) + lazy view chunks |

---

## 1. Client-side dictionary read cache (`src/services/words/cache.ts`)

**What it is.** A module-level `Map<string, Word[]>` in the browser tab, keyed by
`(sourceLang, targetLang, input)`, holding the full sense list per lookup. Capped
at 2,000 entries (oldest-write evicted), per-tab, session-lifetime, cleared on
reload. **No DB, no persistence** — purely a round-trip eliminator in front of the
`words` reads.

**Calls / what it retrieves.** Read-through wraps the three `words` reads in
`repository.ts`:
- `findCachedWord` — reads the cache; returns the preferred sense (`[0]`) without a
  query on a hit; on a miss keeps its `limit(1)` query (doesn't populate the full
  list — one row is incomplete).
- `findWordTranslations` — returns the cached sense list on a hit; on a miss reads
  `words WHERE input/source/target` and memoizes the non-empty result.
- `findWordTranslationsBatch` — checks the cache per input, then one `.in()` query
  for **only the misses**, memoizing each group.

Also primed from edge results (`lookup.ts`) so a word fetched on a cold miss is
memoized immediately, not re-read next time.

**Inefficiency it fixed.** Even when a word was already in the `words` table (a
server-cache hit, no translation needed), the client still paid a Supabase
round-trip per `findWordTranslations` — replayed on every re-translate, swap, or
re-encounter of the same word.

**Why `words` only.** It's read-only to clients and stale data is benign (a slightly
old reading/ranking, never a wrong meaning). Negative (empty) results are **never**
cached — an empty read means "ask the edge function", which then populates `words`;
caching the empty would mask that fresh data for the session.

---

## 2. EN→JA fan-out batching (`lookupWordsBatch` in `lookup.ts`)

**The path.** Learning JA, typing an English word (`bat`): stage 1 is one EN→JA
`lookupWord("bat")` returning the distinct Japanese equivalents (バット, 蝙蝠, …,
capped at 8); stage 2 studies each equivalent JA→native.

**Before.** Stage 2 was `Promise.all(candidates.map(lookupWord))` — one lookup
**per candidate word**, each its own `findWordTranslations` (DB read) **plus** its
own edge call on a miss. (It searched each candidate *word* individually; all of a
word's senses came back together — never per-sense.) Cold worst case: 8 DB reads +
8 edge calls.

**After.** `lookupWordsBatch(candidates)` = one `findWordTranslationsBatch`
(`.in()`, + client cache) for the cached ones, then **one** `translateBatch` for
the misses. Stage 2 → 2 round-trips regardless of candidate count. Behavior
identical: top candidate keeps all senses, the rest contribute their primary,
deduped by `wordId`. An edge failure is non-fatal (cached candidates still resolve).

---

## 3. Batched edge translate endpoint (`translate` function + `translateBatch`)

**The path.** `translateParagraph` does a batched DB read for word meanings, then
resolves each still-uncached word. **Before:** `mapLimit(missing, 6, senseProvider)`
fired **one edge call per uncached word** — a 30-new-word paragraph = 30 edge
round-trips. The whole-paragraph display gloss is a separate `persist:false` call.

**After.** The edge function accepts `{ inputs: string[] }` and resolves them all in
one request (`resolveBatch`): one batched cache read (`fetchVerifiedMany`), then per
miss `jmdict_lookup` → metered Google MT fallback (looped **server-side** — cheap
same-region DB calls, not client round-trips), then **one** `upsert().select()` for
every projected sense, grouped back to each search term (`groupByInput`, matching
`input` OR `input_reading` so a kana search collects its kanji rows). Client:
`translateBatch` → `Map<term, Word[]>`. `translateParagraph` and `lookupWordsBatch`
both use it: N edge calls → **1**. MT metering is unchanged (per word, via
`consume_translation_quota`); one word over quota is skipped, never a whole-batch
failure.

Pure helpers `projectMany` (cross-input dedupe by `dictionary_ref` so the single
upsert can't hit Postgres 21000) and `groupByInput` live in `_lib.ts` and are
unit-tested.

---

## 4. Edge `upsert().select()` — drop the post-write re-read (`index.ts`)

**Before.** On a cache miss the single-word path did `upsert(rows)` then a **second**
`fetchVerified` read to get the generated `word_id`s for the response.

**After.** `upsert(rows).select("*")` returns the written rows inline (sorted
primary-first by `jmdict_sense_pos`). On a miss the cache was empty, so the upserted
rows ARE the complete verified set — one fewer DB round-trip per cold word.

---

## 5. Batched save — "Add all" (`saveDictionaryWords` + `save_dictionary_words` RPC)

**Before.** `useTranslate.addWords` did `Promise.all(words.map(saveDictionaryWord))`
— N RPCs, N transactions (a 30-word paragraph = 30).

**After.** One `save_dictionary_words(user, uuid[], list?)` Postgres function
(`SECURITY INVOKER`, RLS-authorized like the single save) inserts all senses + tags
them into the optional sub-list in **one transaction** via data-modifying CTEs,
returning the rows. The batch is a single user gesture, so there's **no staged
client-side write buffer** and thus no "session ended before my saves flushed"
data-loss window — the write is atomic, all-or-nothing. An unknown/unverified id is
silently skipped (one bad id can't fail the batch).

---

## 6. Review queue ranked in SQL (`getReviewQueue` + `review_queue` RPC)

**Before.** `getReviewQueue` fetched the user's **entire** vocabulary
(`getAllUserWords`), computed `retrievability()` in JS, sorted, then `.slice(limit)`
— O(vocab) rows over the wire to show 20 cards.

**After.** A `review_queue(user, limit, list?)` SQL function does the
`R = exp(-Δdays / stability)` ranking, tie-break, and `LIMIT` server-side, resolving
the shown meaning/readings by joining `words` (mirrors `toUserWord`). Only ≤ `limit`
rows cross the wire — flat regardless of vocabulary size. The formula mirrors
`retrievability()` (kept for the docstring + unit tests). New integration cases in
`rpc.integration.test.ts` (ranking, list scoping, RLS).

---

## 7. Frontend & index (low-risk wins)

- **Code-split views** (`App.tsx`, `React.lazy` + `Suspense`): Translate / Lists /
  Review are separate chunks, so the initial bundle dropped **405.6 KB → 362.3 KB**
  (gz 115 → 104) and Lists/Review code loads on first open.
- **kuromoji idle warm-up** (`warmJapaneseAnalyzer`, fired on `requestIdleCallback`):
  preloads the ~12 MB dictionary during idle so the first paragraph analysis isn't
  slowed. No-op once warm; load errors swallowed (`analyze()` retries/degrades).
- **`input_reading` index** (`idx_words_reading_search`, partial on non-null): the
  cache read matches `input` OR `input_reading` (kana search → kanji headword); the
  reading side was a seq scan — now indexed.

---

## Deliberately NOT done (and why)

- **`user_words` caching** — mutated constantly (save/edit/delete/review); the
  read-after-mutation in `useLists` is correct. Caching it would trade a real win
  for stale-state bugs.
- **`dictionary.ts addWordsToList` batching** — it's test-only, not wired to any
  view/hook; optimizing dead-to-UI code is pure churn.
- **`analyze()` memoization** — `translateParagraph` mutates the returned tokens in
  place (`token.reading`), so a naive memo would alias and corrupt the cache. Not
  worth the subtle bug for a marginal win.
