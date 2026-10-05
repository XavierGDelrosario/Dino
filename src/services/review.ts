// Review / spaced repetition: the READ ranking + the record-a-review write.
//
// A CONTINUOUS forgetting curve, not an interval schedule: each user_word carries a
// `stability` (days) and R(t) = exp(-Δdays / stability). There is no stored due date.
//
// A session is dealt in two phases (migration 20260732 is the authority):
//   DUE  — R ≤ 0.9, most-overdue first. Same line record_review freezes at, so a card
//          the scheduler would learn nothing from is never dealt. Confidence 5 included.
//   FILL — tops the session up from the NOT-due pool, shakiest first (never confidence
//          5). Grading a fill card is frozen — practice, not evidence.
//
// The strength UPDATE math lives in record_review() server-side; this module owns only
// the READ decay shape, and the two share exp(-Δ/S) — keep in sync. Swapping in FSRS is
// a new function body, not a change to the { userWordId, grade } contract.
//
// Two server-side properties invisible here (migration 20260729): EASE (the user↔word
// level gap scales stability growth) and FUZZ (every stability write is jittered so a
// cohort doesn't come due together). retrievability() stays pure — it re-reads the
// already-fuzzed stability.

import { supabase } from "../config/supabaseClient";
import { ServiceError, toServiceError } from "./errors";
import { confidenceInputsOf, type UserWord } from "./words/userWords";
import { findWordsByIds } from "./words/repository";
import { writeWordById } from "./words/vocabularyCache";
import type { LangCode } from "./language";
import { offlineStore } from "./offline/store";
import { anchorAt, getAnchor, setAnchor, stampFor } from "./offline/clock";
import { enqueue, newId, pending } from "./offline/queue";
import { loadDeck, saveDeck, type DeckSlot } from "./offline/deck";

/** 1–5 self-rated recall (1 = forgot … 5 = easy). No separate "again". */
export const REVIEW_GRADES = [1, 2, 3, 4, 5] as const;
export type ReviewGrade = (typeof REVIEW_GRADES)[number];

const MS_PER_DAY = 86_400_000;

/**
 * Did the request fail because the server was UNREACHABLE, as opposed to answering
 * with a refusal?
 *
 * The same distinction `probeSession` draws in session.ts, and it matters for the same
 * reason: only an unreachable server may fall back to the offline path. A server that
 * answered "no" — an invalid grade, a word that isn't yours, an RLS denial — must
 * surface, or the queue would retry a permanent failure forever and the reader would
 * silently deal cards from a stale deck instead of showing the error.
 *
 * PostgREST errors carry a SQLSTATE `code`; a request that never completed carries
 * none. Anything that reached the database is a verdict.
 *
 * Classified by SHAPE, not wording. supabase-js does not throw a failed fetch — it
 * resolves `{ error, status: 0 }` with the browser's own text in `message`, and that
 * text is per-engine: Chrome says "Failed to fetch", WebKit (Safari, and the iOS app's
 * WKWebView) says "Load failed". Matching the words alone left the app unable to queue
 * a grade offline. `status: 0` is the client's "no response at all" on every engine;
 * the wording check stays only for errors that arrive without a response to read.
 */
function isUnreachable(error: unknown, status?: number): boolean {
  if (error instanceof TypeError || error instanceof UnreachableError) return true; // fetch itself failed
  if (status === 0) return true;
  if (typeof status === "number" && status > 0) return false; // it answered
  const e = error as { code?: string; status?: number; message?: string } | null;
  if (!e) return false;
  if (e.code || (typeof e.status === "number" && e.status > 0)) return false;
  return /fetch|network|offline|connection|load failed/i.test(e.message ?? "");
}

/** Did this THROWN review error mean "no answer" rather than "the answer was no"?
 *  For the offline drain, which only sees what `sendReview` threw. */
export function isUnreachableError(error: unknown): boolean {
  return isUnreachable(error);
}

/**
 * The request got no response. Thrown by `sendReview`, which sees the response status;
 * `recordReview` only sees what was thrown, and a ServiceError keeps no status.
 */
class UnreachableError extends ServiceError {}

/**
 * Current recall probability R(t) ∈ [0,1] = exp(-Δdays / stability).
 * MIRRORS the decay shape in record_review() (init migration) — keep in sync.
 */
export function retrievability(
  stability: number | null,
  lastReviewedDate: string | null,
  originallyTranslatedDate: string | null,
  now: number = Date.now()
): number {
  // Cold (no stability) → 0, i.e. most urgent. A calibration-SEEDED word decays from
  // its first-translated date when never reviewed, so the seed affects ranking rather
  // than cold-starting at the front. Mirrors the review_queue SQL.
  if (stability == null || stability <= 0) return 0;
  const anchor = lastReviewedDate ?? originallyTranslatedDate;
  if (anchor == null) return 1; // seeded but undated → treat as fresh/known
  const elapsedDays = Math.max(0, (now - Date.parse(anchor)) / MS_PER_DAY);
  return Math.exp(-elapsedDays / stability);
}

/** A queued review card: a vocabulary word plus its current recall probability. */
export interface ReviewQueueItem extends UserWord {
  /** Current recall probability 0–1; LOWER = more urgent to review. */
  retrievability: number;
}

/** One row from the review_queue() SQL function: a UserWord plus the score. */
interface ReviewQueueRow {
  user_word_id: string;
  user_id: string;
  input: string;
  source_lang: string;
  target_lang: string;
  dictionary_word_id: string | null;
  custom_translation: string | null;
  translation: string;
  input_reading: string | null;
  translation_reading: string | null;
  proficiency_band: number | null;
  part_of_speech: string[] | null;
  frequency: number | null;
  stability: number | null;
  confidence_rating: number;
  last_reviewed_date: string | null;
  originally_translated_date: string;
  retrievability: number;
}

/**
 * A review session: DUE words first, topped up with shaky NOT-due ones (module header).
 * EMPTY is a real answer — nothing due, nothing shaky left. Scoped to `listId` when
 * given, else the whole vocabulary. Ranking + LIMIT run in the `review_queue` function,
 * so only ≤ `limit` cards cross the wire.
 */
interface QueueParams {
  userId: string;
  listId?: string | null;
  limit: number;
  /** Restrict to EXACTLY these ids (the Lists filtered subset); [] = empty queue. */
  userWordIds?: string[];
}

export async function getReviewQueue(params: QueueParams): Promise<ReviewQueueItem[]> {
  const res = await fetchQueue(params);
  if ("error" in res) {
    // Unreachable → deal from a cached deck. Any other error is a real failure and
    // must surface: an offline fallback that swallowed, say, an RLS denial would show
    // a stale session's cards instead of an error.
    if (isUnreachable(res.error, res.status)) {
      const cached = await dealOffline(params);
      if (cached) return cached;
    }
    throw toServiceError(res.error);
  }

  // Only the UNRESTRICTED queue is cached. An explicit `userWordIds` set is the Lists
  // filtered-subset path — a transient selection, not the session someone would come
  // back to offline, and caching it would let a stale filter deal the wrong cards.
  if (params.userWordIds === undefined) {
    await cacheDeck("session", params.userId, params.listId ?? null, res.items);
  }
  return res.items;
}

/**
 * A session from the device, or null when nothing usable is cached.
 *
 * The whole vocabulary prefers the FULL deck (`refreshOfflineDeck`); a list only has
 * the last session dealt in that list. Cards with a grade still waiting in the offline
 * queue are skipped, so a second offline session deals the NEXT cards down the ranking
 * instead of the ones just graded — and an empty answer means the deck is used up.
 * An explicit id set keeps its old behaviour: it names its words, there is no ranking
 * to walk down.
 */
async function dealOffline(params: QueueParams): Promise<ReviewQueueItem[] | null> {
  const store = offlineStore();
  const scope = { userId: params.userId, listId: params.listId ?? null };
  const limit = Math.max(0, params.limit);

  const session = await loadDeck(store, scope);
  if (params.userWordIds !== undefined) return session ? session.items.slice(0, limit) : null;

  const full = scope.listId === null ? await loadDeck(store, { ...scope, slot: "full" }) : null;
  const deck = full ?? session;
  if (!deck) return null;
  const graded = new Set((await pending(store)).map((e) => e.userWordId));
  return deck.items.filter((i) => !graded.has(i.userWordId)).slice(0, limit);
}

/** The live queue with its cards' examples, or the failure exactly as the client reported it. */
async function fetchQueue(
  params: QueueParams,
): Promise<{ items: ReviewQueueItem[] } | { error: { message: string; code?: string }; status: number }> {
  const { data, error, status } = await supabase.rpc("review_queue", {
    p_user_id: params.userId,
    p_limit: Math.max(0, params.limit),
    p_list_id: params.listId ?? undefined,
    // undefined → no restriction; [] → matches nothing.
    p_user_word_ids: params.userWordIds ?? undefined,
  });
  if (error) return { error, status };

  const rows = (data ?? []) as ReviewQueueRow[];
  const items = rows.map((r) => ({
    userWordId: r.user_word_id,
    userId: r.user_id,
    input: r.input,
    sourceLang: r.source_lang as LangCode,
    targetLang: r.target_lang as LangCode,
    dictionaryWordId: r.dictionary_word_id,
    customTranslation: r.custom_translation,
    translation: r.translation,
    inputReading: r.input_reading,
    translationReading: r.translation_reading,
    stability: r.stability,
    confidenceRating: r.confidence_rating,
    lastReviewedDate: r.last_reviewed_date,
    originallyTranslatedDate: r.originally_translated_date,
    proficiencyBand: r.proficiency_band,
    partOfSpeech: r.part_of_speech,
    frequency: r.frequency,
    // Sense enrichment (20260750) isn't in review_queue's column list — filled in just
    // below from the `words` cache (the card's "Show example").
    example: null as string | null,
    exampleGloss: null as string | null,
    definitionSource: null as string | null,
    exampleReading: null as string | null,
    retrievability: r.retrievability,
  }));

  // The example sentence for each card, read by id from `words` (one round-trip for
  // ≤ limit ids) rather than by widening review_queue, which would need a migration in
  // every environment first. BEST-EFFORT: the example is a hint, so a failed read
  // leaves the cards example-less instead of failing a session that loaded fine.
  try {
    const senses = await findWordsByIds(
      items.map((i) => i.dictionaryWordId).filter((id): id is string => Boolean(id)),
    );
    for (const item of items) {
      const sense = item.dictionaryWordId ? senses.get(item.dictionaryWordId) : undefined;
      if (!sense) continue;
      item.example = sense.example;
      item.exampleGloss = sense.exampleGloss;
      item.definitionSource = sense.definitionSource;
      item.exampleReading = sense.exampleReading;
    }
  } catch (e) {
    console.warn("[review] couldn't load card examples; continuing without them.", e);
  }

  return { items };
}

/**
 * Cache a deck for a later offline session, anchored to the SERVER's clock so an
 * offline grade can be timestamped without ever reading the device's (see clock.ts).
 * Best-effort: a storage failure must not fail a review that is working fine online.
 */
async function cacheDeck(
  slot: DeckSlot,
  userId: string,
  listId: string | null,
  items: ReviewQueueItem[],
): Promise<void> {
  try {
    const anchor = anchorAt(await serverTime());
    setAnchor(anchor); // in-memory; see the note in clock.ts on why it isn't persisted
    await saveDeck(offlineStore(), { userId, listId, anchor, items }, slot);
  } catch {
    /* deck caching is an enhancement; never fail the online path for it */
  }
}

/** How deep the prefetched offline deck goes — ~15 sessions, a few hundred KB on disk. */
export const OFFLINE_DECK_SIZE = 300;

/**
 * Fetch the FULL offline deck: the top OFFLINE_DECK_SIZE of the whole vocabulary's
 * queue, still ranked and dealt by the server, so the device holds no second copy of
 * the due/fill rules — only a longer answer from the one that exists. Best-effort and
 * silent: offline, or on any failure, the deck already on the device stays as it is.
 */
export async function refreshOfflineDeck(userId: string): Promise<boolean> {
  try {
    const res = await fetchQueue({ userId, limit: OFFLINE_DECK_SIZE });
    if ("error" in res) return false;
    await cacheDeck("full", userId, null, res.items);
    return true;
  } catch {
    return false;
  }
}

/** Quiet period after the last grade reaches the server before the deck is re-fetched. */
const DECK_REFRESH_DELAY_MS = 30_000;
let deckOwner: string | null = null;
let deckTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Keep the full offline deck current for `userId`: fetched now, on every reconnect,
 * and shortly after grades reach the server (below) — a deck fetched BEFORE a session
 * would otherwise deal that session's cards again offline. Returns a teardown.
 */
export function watchOfflineDeck(userId: string): () => void {
  deckOwner = userId;
  const refresh = () => void refreshOfflineDeck(userId);
  refresh();
  if (typeof window !== "undefined") window.addEventListener("online", refresh);
  return () => {
    if (deckOwner === userId) deckOwner = null;
    clearTimeout(deckTimer);
    if (typeof window !== "undefined") window.removeEventListener("online", refresh);
  };
}

/** A grade just landed, so the cached ranking is out of date. Debounced: a session's
 *  worth of grades costs one re-fetch. No-op unless a deck is being kept (the app). */
function scheduleDeckRefresh(): void {
  const owner = deckOwner;
  if (!owner) return;
  clearTimeout(deckTimer);
  deckTimer = setTimeout(() => void refreshOfflineDeck(owner), DECK_REFRESH_DELAY_MS);
}

/**
 * The server's clock, for anchoring offline timestamps (migration 20260759).
 *
 * One extra round-trip per DECK FETCH — not per card — which buys the property the
 * whole offline-timestamp design rests on: the anchor is the server's instant, so a
 * device whose clock is simply wrong cannot poison the reviews measured from it.
 *
 * Falls back to local time if the call fails. That costs accuracy, never correctness:
 * record_review clamps whatever it is given to [last_reviewed_date, now()].
 */
async function serverTime(): Promise<number> {
  const { data, error } = await supabase.rpc("server_now");
  const parsed = error || !data ? NaN : Date.parse(data as string);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

/** The post-review mastery state returned by record_review(). */
export interface ReviewResult {
  userWordId: string;
  /** Updated memory strength (days). */
  stability: number;
  /** Updated 0–5 display bucket. */
  confidenceRating: number;
  /** Server timestamp of this review. */
  lastReviewedDate: string;
  /** True when the grade was QUEUED offline: the values above are the pre-review ones
   *  and the real schedule lands on sync. Absent on the normal online path. */
  queued?: boolean;
}

/** What record_review / soften_confidence return: the whole updated user_words row. */
type ReturnedRow = {
  user_word_id: string;
  stability: number;
  confidence_rating: number;
  last_reviewed_date: string;
  originally_translated_date: string;
  short_stability?: number | null;
  short_stability_at?: string | null;
  peak_confidence?: number | null;
};

/** Write the new schedule through to the vocabulary cache, so Lists shows the grade
 *  without re-reading. The row carries every confidence input, so the cached word
 *  re-derives (on read) the exact number the server would. */
function cacheReviewed(row: ReturnedRow): void {
  writeWordById(row.user_word_id, {
    stability: row.stability,
    lastReviewedDate: row.last_reviewed_date,
    confidenceInputs: confidenceInputsOf(row),
  });
}

/** False once the database has said it has no record_review(…, p_reversed) — migration
 *  20260784 not applied there yet. The client and the DB deploy separately, so that gap
 *  is reachable in production; the grade matters more than its direction, so it is sent
 *  again without one and the rest of the session stops offering it. */
let directionSupported = true;

/** Test hook: the latch above is module-global. */
export function __resetDirectionProbe(): void {
  directionSupported = true;
}

/**
 * Send a review to the server. ALWAYS hits the network and never queues — this is the
 * raw write, used by `recordReview` below and by the offline drain (offline/sync.ts),
 * which must not re-queue what it is replaying.
 *
 * `reviewedAt` names the instant the grade was given, for a replay. The server clamps
 * it to [last_reviewed_date, now()] — see migration 20260759.
 *
 * `reversed` is which face of the card was up (true = meaning-first, the quiz flip).
 * It is LOGGED, never scheduled on: one grade moves the word's one schedule whichever
 * way the card faced (migration 20260784). Omitted = not recorded.
 */
export async function sendReview(params: {
  userWordId: string;
  grade: ReviewGrade;
  reviewedAt?: string;
  reversed?: boolean;
}): Promise<ReviewResult> {
  const send = (withDirection: boolean) =>
    supabase.rpc("record_review", {
      p_user_word_id: params.userWordId,
      p_grade: params.grade,
      p_reviewed_at: params.reviewedAt ?? undefined,
      p_reversed: withDirection ? params.reversed : undefined,
    });
  const hasDirection = directionSupported && params.reversed !== undefined;
  let { data, error, status } = await send(hasDirection);
  // PGRST202 = no function with these argument names. Only the direction is new.
  if (error?.code === "PGRST202" && hasDirection) {
    directionSupported = false;
    console.warn("review: record_review has no p_reversed (migration 20260784 not applied)");
    ({ data, error, status } = await send(false));
  }
  if (error && isUnreachable(error, status)) {
    throw new UnreachableError(error.message, "unknown", { cause: error });
  }
  if (error || !data) throw toServiceError(error, "Failed to record review");

  // RETURNS user_words → a single row (PostgREST may wrap it in an array).
  const row = (Array.isArray(data) ? data[0] : data) as ReturnedRow;
  cacheReviewed(row);
  scheduleDeckRefresh();
  return {
    userWordId: row.user_word_id,
    stability: row.stability,
    confidenceRating: row.confidence_rating,
    lastReviewedDate: row.last_reviewed_date,
  };
}

/**
 * Records one review. The schedule math (strength + confidence + the clock + history
 * log) runs atomically in `record_review`, so the algorithm can be swapped server-side.
 * The word must belong to the caller (enforced by RLS in the RPC).
 *
 * OFFLINE: the grade is queued and replayed on reconnect, and the returned values are
 * the card's PRE-review ones with `queued: true`. Deliberately not an optimistic
 * guess — the real stability needs `srs_leveling`, which is revoked from clients
 * (20260748), so any number invented here would be a different one from the server's
 * and would have to be silently corrected later.
 *
 * Only a genuinely unreachable server queues. A rejection (an invalid grade, a word
 * that isn't yours) throws as it always did — queueing it would hide a real bug and
 * retry it forever.
 */
export async function recordReview(params: {
  userWordId: string;
  grade: ReviewGrade;
  /** Which face was up when the grade was given (true = meaning-first). See sendReview. */
  reversed?: boolean;
  /** The card as displayed, so a queued grade can echo its current state back. */
  current?: { stability: number | null; confidenceRating: number; lastReviewedDate: string | null };
}): Promise<ReviewResult> {
  try {
    return await sendReview(params);
  } catch (e) {
    if (!isUnreachable(e)) throw e;

    const store = offlineStore();
    const stamp = stampFor(getAnchor());
    const { data } = await supabase.auth.getSession(); // local read; works offline
    await enqueue(store, {
      id: newId(),
      userId: data.session?.user.id,
      userWordId: params.userWordId,
      grade: params.grade,
      reversed: params.reversed,
      reviewedAt: stamp.reviewedAt,
      approx: stamp.approx,
    });
    return {
      userWordId: params.userWordId,
      stability: params.current?.stability ?? 0,
      confidenceRating: params.current?.confidenceRating ?? 0,
      lastReviewedDate: params.current?.lastReviewedDate ?? stamp.reviewedAt,
      queued: true,
    };
  }
}

/** Below this displayed confidence there is nothing to soften — the server enforces
 *  the same floor, so this is the UI's copy of one rule, not a second rule. */
export const SOFTEN_MIN_CONFIDENCE = 3;

/** Is there anything for "Forgot" to do at this displayed confidence? Every surface
 *  that offers the control asks through this, so the floor is stated once: the reader
 *  (whether to show the button), the dots (whether they are inert text) and the hook
 *  (which senses to actually send) all used to spell it out separately. */
export function canSoften(confidence: number | null | undefined): boolean {
  return (confidence ?? 0) >= SOFTEN_MIN_CONFIDENCE;
}

/**
 * "Forgot" — drop ONE displayed-confidence bucket for a word the user is reading, and
 * pull its next review in. Not a graded review: nothing is written to `review_log`
 * (see migration 20260766 for why that distinction is load-bearing).
 *
 * IDEMPOTENT BY CONSTRUCTION, twice over: the server no-ops below
 * SOFTEN_MIN_CONFIDENCE and again for any word touched in the last 2 seconds, so a
 * double-tap returns the SAME row rather than dropping two notches. Callers should
 * still hold the button until the user has seen the new number.
 *
 * The returned confidence is what actually happened, which is usually current − 1 but
 * can be lower: the function never RAISES stability, so a number propped up by a cram
 * session falls to what the long term really supports.
 *
 * Deliberately NOT offline-queueable. The offline store carries grades, and this isn't
 * one; an unreachable server throws and the button stays as it was.
 */
export async function softenConfidence(params: { userWordId: string }): Promise<ReviewResult> {
  const { data, error } = await supabase.rpc("soften_confidence", {
    p_user_word_id: params.userWordId,
  });
  if (error || !data) throw toServiceError(error, "Failed to lower confidence");

  // RETURNS user_words → a single row (PostgREST may wrap it in an array).
  const row = (Array.isArray(data) ? data[0] : data) as ReturnedRow;
  cacheReviewed(row);
  return {
    userWordId: row.user_word_id,
    stability: row.stability,
    confidenceRating: row.confidence_rating,
    lastReviewedDate: row.last_reviewed_date,
  };
}
