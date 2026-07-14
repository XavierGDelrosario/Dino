// =========================================================
// Review / spaced repetition (READ ranking + the record-a-review write).
//
// The model is a CONTINUOUS forgetting curve, not an interval schedule. Each
// user_word carries a `stability` (memory strength, in days); recall
// probability at time t is the Ebbinghaus/Duolingo-HLR shape
//   R(t) = exp(-Δdays / stability).
// There is NO stored next-review date: the "review queue" is simply the user's
// vocabulary ranked by CURRENT R ascending (least confident first). A scheduled
// quiz is "give me the N least-confident words", never "these are due now".
//
// Split of responsibility:
//   * retrievability()  — the pure decay formula (ranking, fully unit-tested).
//   * getReviewQueue()  — ranks the vocabulary by live R (read).
//   * recordReview()    — delegates the atomic, server-clocked state update to
//                         the `record_review` Postgres function (write).
//
// The strength UPDATE math lives server-side in record_review() (one atomic,
// now()-stamped read-modify-write — see the migration); this module only owns
// the READ decay shape. The two share the exp(-Δ/S) curve — keep them in sync.
// Swapping in the in-depth algorithm (FSRS) is a new function body + this
// formula; the { userWordId, grade } contract below does not change.
//
// TWO server-side properties the client can't see, both in 20260729 (read it before
// reasoning about why a word did or didn't come back):
//   * EASE — the gap between the user's level and the word's scales how fast a
//     recalled word's stability grows, so beginner vocabulary you clearly know
//     leaves the rotation instead of grinding round every few weeks. A lapse gets
//     no ease, so a word you actually forget returns promptly.
//   * FUZZ — every stability write is jittered, so words seeded or reviewed
//     TOGETHER don't come due together. retrievability() below stays pure and
//     deterministic (it re-reads the stored, already-fuzzed stability); the
//     nondeterminism lives entirely at the write, plus a ±15% jitter on the
//     queue's ordering so a tied cohort isn't replayed in the same block.
// =========================================================

import { supabase } from "../config/supabaseClient";
import { toServiceError } from "./errors";
import { type UserWord } from "./words/userWords";
import type { LangCode } from "./language";

/** The per-review grade the UI sends: a 1–5 self-rated recall confidence
 *  (1 = forgot … 5 = easy). No separate "again" — a forgotten card is grade 1. */
export const REVIEW_GRADES = [1, 2, 3, 4, 5] as const;
export type ReviewGrade = (typeof REVIEW_GRADES)[number];

const MS_PER_DAY = 86_400_000;

/**
 * Current recall probability R(t) ∈ [0,1] under the exponential forgetting
 * curve R = exp(-Δdays / stability). A never-reviewed word (no stability, or no
 * last-reviewed date) returns 0 so it sorts to the FRONT of the review queue.
 *
 * MIRRORS the decay shape in record_review() (the init migration) — keep in sync.
 */
export function retrievability(
  stability: number | null,
  lastReviewedDate: string | null,
  originallyTranslatedDate: string | null,
  now: number = Date.now()
): number {
  // A truly cold word (no stability) is most urgent → 0. A SEEDED word (#10
  // calibration sets stability before any review) decays from its last review, or —
  // if never reviewed — from when it was first translated, so the seed actually
  // affects ranking instead of cold-starting at the front. Mirrors review_queue SQL.
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

/** One row from the review_queue() SQL function (resolved meaning/readings +
 *  server-computed retrievability), shaped like a UserWord plus the score. */
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
 * The N least-confident words, ranked by CURRENT retrievability ascending (new /
 * most-forgotten first), ties broken by oldest review. This is the review surface
 * — not a due-date schedule. Scoped to one sub-list when `listId` is given, else
 * the whole vocabulary (ALL).
 *
 * The ranking + LIMIT run in the `review_queue` Postgres function, so only the ≤
 * `limit` cards cross the wire (not the whole vocabulary). The R = exp(-Δ/S)
 * formula there mirrors retrievability() below — keep them in sync.
 *
 * OUTPUT: ReviewQueueItem[] of length ≤ limit (may be empty).
 */
export async function getReviewQueue(params: {
  userId: string;
  listId?: string | null;
  limit: number;
  /** Restrict the queue to EXACTLY these user_word_ids (the Lists view's filtered
   *  subset). Passing [] yields an empty queue (filters matched nothing). When
   *  omitted, the whole list/vocabulary is queued as before. */
  userWordIds?: string[];
}): Promise<ReviewQueueItem[]> {
  const { data, error } = await supabase.rpc("review_queue", {
    p_user_id: params.userId,
    p_limit: Math.max(0, params.limit),
    p_list_id: params.listId ?? undefined,
    // Restrict to the Lists subset SERVER-side with the real LIMIT — no longer pull
    // the whole ranked vocabulary (was capped at 100k) to filter + slice in JS.
    // `undefined` → omitted → no restriction; `[]` → matches nothing → empty queue.
    p_user_word_ids: params.userWordIds ?? undefined,
  });
  if (error) throw toServiceError(error);

  const rows = (data ?? []) as ReviewQueueRow[];
  return rows.map((r) => ({
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
    retrievability: r.retrievability,
  }));
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
}

/**
 * Records one review of a word, applying the grade. The schedule math (new
 * strength + confidence + the now() stamp + history log) runs atomically inside
 * the `record_review` Postgres function — the client never computes it, so the
 * algorithm can be swapped server-side without touching this contract.
 *
 * OUTPUT: the updated ReviewResult.
 * CONSTRAINTS: the word must belong to the caller (enforced by RLS in the RPC).
 */
export async function recordReview(params: {
  userWordId: string;
  grade: ReviewGrade;
}): Promise<ReviewResult> {
  const { data, error } = await supabase.rpc("record_review", {
    p_user_word_id: params.userWordId,
    p_grade: params.grade,
  });
  if (error || !data) throw toServiceError(error, "Failed to record review");

  // RETURNS user_words → a single row (PostgREST may wrap it in an array).
  const row = (Array.isArray(data) ? data[0] : data) as {
    user_word_id: string;
    stability: number;
    confidence_rating: number;
    last_reviewed_date: string;
  };
  return {
    userWordId: row.user_word_id,
    stability: row.stability,
    confidenceRating: row.confidence_rating,
    lastReviewedDate: row.last_reviewed_date,
  };
}
