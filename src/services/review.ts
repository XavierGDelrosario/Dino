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
import { toServiceError } from "./errors";
import { type UserWord } from "./words/userWords";
import type { LangCode } from "./language";

/** 1–5 self-rated recall (1 = forgot … 5 = easy). No separate "again". */
export const REVIEW_GRADES = [1, 2, 3, 4, 5] as const;
export type ReviewGrade = (typeof REVIEW_GRADES)[number];

const MS_PER_DAY = 86_400_000;

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
export async function getReviewQueue(params: {
  userId: string;
  listId?: string | null;
  limit: number;
  /** Restrict to EXACTLY these ids (the Lists filtered subset); [] = empty queue. */
  userWordIds?: string[];
}): Promise<ReviewQueueItem[]> {
  const { data, error } = await supabase.rpc("review_queue", {
    p_user_id: params.userId,
    p_limit: Math.max(0, params.limit),
    p_list_id: params.listId ?? undefined,
    // undefined → no restriction; [] → matches nothing.
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
    // Sense enrichment (20260750) isn't in review_queue's column list; surfacing an
    // example on a card means widening that SQL function. Explicitly null, not forgotten.
    example: null,
    exampleGloss: null,
    definitionSource: null,
    exampleReading: null,
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
 * Records one review. The schedule math (strength + confidence + now() + history log)
 * runs atomically in `record_review`, so the algorithm can be swapped server-side.
 * The word must belong to the caller (enforced by RLS in the RPC).
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
