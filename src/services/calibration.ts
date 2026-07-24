// =========================================================
// Level calibration (#10) — estimate a user's level from quiz results and seed
// the SRS so their known words don't all cold-start at 0.
//
// Two PURE functions (the algorithm, unit-tested) + the persistence of the
// estimate on `users.level`. The estimate is deliberately CONSERVATIVE — biased
// to UNDER-rate the user — because the error is asymmetric: under-rating just
// surfaces a word a little more often (cheap, self-corrected by the next review),
// while over-rating can hide a word the user actually needs to see. A wrong guess
// is fine; it gets readjusted by future quizzes/reviews.
//
// Difficulty (per word) comes from services/difficulty (getDifficulty); the grade
// is the same 1..5 self-rated recall the SRS uses (services/review). This module
// is source-agnostic: the samples can come from a pasted paragraph OR a generic
// difficulty-sampled set — calibration doesn't care where the words came from.
// =========================================================

import { supabase } from "../config/supabaseClient";
import { toServiceError } from "./errors";
import type { LevelValue } from "./difficulty";
import type { ReviewGrade } from "./review";

/** One graded calibration item: a word's difficulty paired with how the user did. */
export interface CalibrationSample {
  /** The word's difficulty 1..5 (from getDifficulty). */
  difficulty: LevelValue;
  /** The user's 1..5 self-rated recall for it. */
  grade: ReviewGrade;
}

/** Grade ≥ this counts as "recalled" — matches record_review's lapse cutoff (1–2 lapse, 3–5 recall). */
const RECALLED_GRADE = 3;
/** A difficulty level must be recalled at least this fraction to be credited.
 *  High on purpose: the user must CLEARLY know a level, biasing the estimate down. */
const PASS_THRESHOLD = 0.75;

/**
 * Estimate the user's level (1..5) from calibration samples, or null when there's
 * nothing to credit. Walks difficulty levels 1→5: skips untested levels, credits a
 * tested level whose recall clears PASS_THRESHOLD, and STOPS at the first tested
 * level that fails (never extrapolates above what was actually tested). The result
 * is the highest tested-and-passed level before the first tested failure.
 *
 * CONSERVATIVE by construction: strict threshold, no credit for untested-then-failed
 * gaps, and the seeding step (seedStability) shades the result down further.
 */
export function estimateLevel(samples: CalibrationSample[]): LevelValue | null {
  if (samples.length === 0) return null;

  const recalledByLevel = new Map<LevelValue, { hits: number; total: number }>();
  for (const s of samples) {
    const acc = recalledByLevel.get(s.difficulty) ?? { hits: 0, total: 0 };
    acc.hits += s.grade >= RECALLED_GRADE ? 1 : 0;
    acc.total += 1;
    recalledByLevel.set(s.difficulty, acc);
  }

  let estimate: LevelValue | null = null;
  for (let lvl = 1; lvl <= 5; lvl++) {
    const acc = recalledByLevel.get(lvl as LevelValue);
    if (!acc) continue; // untested at this level → skip, don't credit or fail on it
    if (acc.hits / acc.total < PASS_THRESHOLD) break; // failed a TESTED level → stop climbing
    estimate = lvl as LevelValue; // passed → credit it, keep going
  }
  return estimate;
}

// ── Adaptive placement quiz (#10, the "Find my level" flow) ────────────────
// A DIFFERENT calibration path from estimateLevel above: instead of grading a
// fixed paragraph, it searches the proficiency bands. Each round shows a batch of
// words at one band; the user marks the ones they DON'T know; if they know ≥
// CALIBRATION_TARGET of the batch the band is "passed" and we search harder, else
// easier. The result is the HARDEST band passed.
//
// STABILITY OVER REACH (the fix for "a retake swings me N2 → N4"). A band is
// decided on a SMALL sample, so a single unlucky word used to flip it — and the
// binary search then jumped two bands and OVERWROTE the stored level outright.
// Three things now damp that, in increasing order of importance:
//   1. A BORDERLINE batch (known-fraction within BORDERLINE_MARGIN of the cutoff —
//      i.e. a coin-flip) is not decided: the band is re-tested once and the two
//      batches are POOLED, so the call is made on double the evidence.
//   2. With a PRIOR level, the search only spans prior ± 1 — a re-calibration is
//      an adjustment, not a from-scratch guess, and it converges in ≤ 2 rounds.
//   3. The result is CLAMPED to prior ± 1 regardless (resolveLevelMove), so even
//      failing every band in range can only step you down one.
// A user who genuinely jumped two levels reaches it by retaking again — the cost
// of being wrong upward (words silently never surfacing) is far worse than the
// cost of being wrong downward (a slightly-too-easy review).
//
// PURE state machine (unit-tested): the hook owns fetching/answers, this owns the
// search. Bands are the framework ordinal (1 = easiest); the result is clamped to
// the 1..5 users.level scale (JLPT is 5 bands, so it fits).

/** Fraction of a batch the user must know for a band to count as "passed". */
export const CALIBRATION_TARGET = 0.8;

/** A known-fraction this close to CALIBRATION_TARGET is a coin-flip, not a verdict:
 *  the band gets one confirming batch and is decided on the POOLED sample. (At a
 *  12-word batch, 9/12 = .75 and 10/12 = .83 both land here — exactly the one-word
 *  swings that used to move a whole band.) */
export const BORDERLINE_MARGIN = 0.15;

/** Search cursor over the bands 1..maxBand. `band` is the one to test now; `best`
 *  is the hardest band passed so far (0 = none yet); `prior` is the user's stored
 *  band, which bounds how far this calibration may move them (null = first time,
 *  unbounded); `pooled` carries an inconclusive batch's counts into the confirming
 *  round at the same band. */
export interface BandSearch {
  lo: number;
  hi: number;
  best: number;
  band: number;
  prior: number | null;
  pooled?: { known: number; total: number };
}

/**
 * Begin a search over bands 1..maxBand. With no `prior` (first calibration) this is
 * a plain binary search from the middle band. With a prior it searches ONLY
 * prior ± 1 (starting AT the prior), so a re-calibration confirms-or-nudges instead
 * of re-guessing from scratch — fewer rounds, and no room for a wild swing.
 */
export function startBandSearch(maxBand: number, prior: number | null = null): BandSearch {
  const max = Math.max(1, maxBand);
  const lo = prior == null ? 1 : Math.max(1, prior - 1);
  const hi = prior == null ? max : Math.min(max, prior + 1);
  const band = prior == null ? Math.floor((lo + hi) / 2) : Math.min(hi, Math.max(lo, prior));
  return { lo, hi, best: 0, band, prior };
}

/**
 * The level a calibration may actually record: the measured band, clamped to the 1..5
 * users.level range AND to within one band of the `prior` (when there is one). A
 * measured 0 (failed every band tested) means "below everything we tried" → one band
 * below the prior, or level 1 for a first calibration.
 */
export function resolveLevelMove(measured: number, prior: number | null): LevelValue {
  const target = measured > 0 ? measured : (prior ?? 1) - 1;
  const lo = prior == null ? 1 : prior - 1;
  const hi = prior == null ? 5 : prior + 1;
  return Math.min(5, Math.max(1, Math.min(hi, Math.max(lo, target)))) as LevelValue;
}

/**
 * Fold one round's result (how many of the batch's `total` words the user KNEW) into
 * the search. Returns either the next band to test — which may be the SAME band, when
 * the batch was too close to the cutoff to call (see BORDERLINE_MARGIN) — or the final
 * level once the search has converged (lo > hi), clamped to within one band of the
 * prior by resolveLevelMove.
 */
export function advanceBandSearch(
  s: BandSearch,
  known: number,
  total: number,
): { done: true; level: LevelValue } | { done: false; search: BandSearch } {
  const pooledKnown = (s.pooled?.known ?? 0) + known;
  const pooledTotal = (s.pooled?.total ?? 0) + total;
  const fraction = pooledTotal > 0 ? pooledKnown / pooledTotal : 0;

  // Too close to call, and this band hasn't been confirmed yet → re-test it and
  // decide on the pooled sample. Only ever ONE confirming round per band (`pooled`
  // is already set the second time through), so the quiz can't loop.
  if (s.pooled == null && Math.abs(fraction - CALIBRATION_TARGET) <= BORDERLINE_MARGIN) {
    return { done: false, search: { ...s, pooled: { known: pooledKnown, total: pooledTotal } } };
  }

  const passed = fraction >= CALIBRATION_TARGET;
  const lo = passed ? s.band + 1 : s.lo;
  const hi = passed ? s.hi : s.band - 1;
  const best = passed ? s.band : s.best;
  if (lo > hi) {
    return { done: true, level: resolveLevelMove(best, s.prior) };
  }
  // Fresh band → drop the pooled counts (they belong to the band just decided).
  return { done: false, search: { lo, hi, best, band: Math.floor((lo + hi) / 2), prior: s.prior } };
}

/** Modest day-values for the initial memory strength of a pre-known word, indexed
 *  by how far BELOW the (shaded) user level the word sits. Kept small so an over-
 *  credit only lengthens the first interval slightly — never hides the word.
 *
 *  NOTE: this is the ONLY place the user↔word level gap affects scheduling today.
 *  The server fuzzes whatever seed it is given (save_dictionary_word), but it does
 *  not yet scale it by level — that lands with the per-language leveling registry,
 *  which is where the gap belongs (its accuracy is language-specific and, measured
 *  against JLPT, only ~24% predictive from frequency alone). */
const SEED_STABILITY_BY_GAP = [1.5, 3.5, 7.0] as const;

/**
 * Initial `stability` (days) for a freshly-added, UN-quizzed word given its
 * difficulty and the user's estimated level — or null to cold-start (the default).
 *
 * CONSERVATIVE: treats the user as one level lower (`userLevel - 1`) and only seeds
 * words at/below that shaded level; anything at or above it cold-starts. So a wrong
 * estimate errs toward "review it a bit sooner," never "never review it."
 *
 * OUTPUT: a small positive day-count (the server fuzzes it), or null (cold start).
 */
export function seedStability(
  difficulty: LevelValue | null,
  userLevel: LevelValue | null,
): number | null {
  if (difficulty == null || userLevel == null) return null; // unknown → cold start
  const shadedLevel = userLevel - 1; // conservative: assume one level lower
  const gap = shadedLevel - difficulty; // how comfortably below the user the word is
  if (gap < 0) return null; // at/above the shaded level → cold start
  return SEED_STABILITY_BY_GAP[Math.min(gap, SEED_STABILITY_BY_GAP.length - 1)];
}

/**
 * The user's stored level estimate (1..5), or null if never calibrated.
 * OUTPUT: LevelValue | null. CONSTRAINTS: RLS-scoped to the caller's own row.
 */
export async function getUserLevel(userId: string): Promise<LevelValue | null> {
  const { data, error } = await supabase
    .from("users")
    .select("level")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw toServiceError(error);
  return (data?.level ?? null) as LevelValue | null;
}

/**
 * Persists the user's level estimate (null clears it). Written directly via the
 * own-row UPDATE RLS policy — it's the user's own calibration result.
 * OUTPUT: void. CONSTRAINTS: RLS authorizes (own row only).
 */
export async function setUserLevel(userId: string, level: LevelValue | null): Promise<void> {
  const { error } = await supabase.from("users").update({ level }).eq("user_id", userId);
  if (error) throw toServiceError(error);
}

// ── Proficiency band (the SEPARATE proficiency axis) ───────────────────────
// users.proficiency_band holds the placement quiz's JLPT/CEFR band — DISTINCT from
// users.level (difficulty/frequency). Kept apart on purpose so the embeddings/seed
// consumers of `level` never see a band and vice versa (never conflate the axes).
// The raw ordinal is framework-relative (1 = easiest); services/proficiency maps it
// to a label. The placement quiz writes this alongside a difficulty estimate.

/** The user's stored proficiency band (framework ordinal, 1 = easiest), or null if
 *  never calibrated. RLS-scoped to the caller's own row. */
export async function getUserProficiencyBand(userId: string): Promise<number | null> {
  const { data, error } = await supabase
    .from("users")
    .select("proficiency_band")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw toServiceError(error);
  return (data?.proficiency_band ?? null) as number | null;
}

/** Persists the user's proficiency band (null clears it). Own-row UPDATE. */
export async function setUserProficiencyBand(userId: string, band: number | null): Promise<void> {
  const { error } = await supabase.from("users").update({ proficiency_band: band }).eq("user_id", userId);
  if (error) throw toServiceError(error);
}
