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

/** Modest day-values for the initial memory strength of a pre-known word, indexed
 *  by how far BELOW the (shaded) user level the word sits. Kept small so an over-
 *  credit only lengthens the first interval slightly — never hides the word. */
const SEED_STABILITY_BY_GAP = [1.5, 3.5, 7.0] as const;

/**
 * Initial `stability` (days) for a freshly-added, UN-quizzed word given its
 * difficulty and the user's estimated level — or null to cold-start (the default).
 *
 * CONSERVATIVE: treats the user as one level lower (`userLevel - 1`) and only seeds
 * words at/below that shaded level; anything at or above it cold-starts. So a wrong
 * estimate errs toward "review it a bit sooner," never "never review it."
 *
 * OUTPUT: a small positive day-count, or null (no seed → cold start).
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
