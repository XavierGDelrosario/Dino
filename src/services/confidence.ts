// =========================================================
// The DISPLAYED confidence (0–5) — a live value, distinct from the SCHEDULE.
//
// `stability` answers "when should this card come back". This module answers the
// different question the UI actually asks: "how well does the user know this word
// RIGHT NOW". Migration 20260735 is the authority; this is the client-side mirror,
// needed because the Lists surface reads `user_words` straight through PostgREST and
// never passes through review_queue. KEEP THE TWO IN SYNC — the constants below are
// pinned by tests/services/confidence.test.ts against the values in that migration.
//
// Three inputs, summed into an "effective strength" that goes through the same
// bucket the scheduler has always used:
//
//   1. LONG-TERM, gently decayed — S · R^0.35, where R = exp(-Δ/S). Deliberately NOT
//      S · R: the scheduler decays on the true curve, but the reader is told something
//      softer, because "due for a look" and "forgotten" are different claims. A mature
//      40-day word holds 5/5 for a fortnight instead of dropping within the week.
//   2. SHORT-TERM, fast — the strength any successful pass adds (including the ones the
//      scheduler freezes as cramming), half-lived in 8 hours. This is what makes a
//      session's work visible: 0 → 4 while you quiz, back to 2 by morning.
//   3. A FLOOR at 3 once the word has genuinely reached 5/5, so a shelf of mature words
//      reads "due for a look" rather than decaying to zero and looking like lost work.
//      Earned from LONG-TERM strength only — cramming can't buy the floor.
// =========================================================

/** Half-life of the short-term display strength, in hours. */
export const SHORT_HALF_LIFE_HOURS = 8;
/** Display decay exponent on R. 1.0 would fade exactly as fast as true recall. */
export const DISPLAY_DECAY_EXPONENT = 0.35;
/** Floor applied once `peakConfidence` has reached 5. */
export const PEAK_FLOOR = 3;

const MS_PER_DAY = 86_400_000;
const MS_PER_HOUR = 3_600_000;

/** The 0–5 bucket over a strength in days. Mirrors confidence_from_stability(). */
export function confidenceFromStability(strengthDays: number | null): number {
  if (strengthDays == null || strengthDays < 1) return 0;
  if (strengthDays < 3) return 1;
  if (strengthDays < 7) return 2;
  if (strengthDays < 16) return 3;
  if (strengthDays < 35) return 4;
  return 5;
}

/** The per-word state the display value is computed from (a subset of `user_words`). */
export interface ConfidenceInputs {
  stability: number | null;
  lastReviewedDate: string | null;
  /** Fallback decay anchor for a seeded-but-never-reviewed word (see review.ts). */
  originallyTranslatedDate: string | null;
  shortStability: number | null;
  shortStabilityAt: string | null;
  peakConfidence: number | null;
}

/**
 * The 0–5 the user sees, at `now`. Pure: no I/O, no clock of its own beyond the
 * default — pass `now` to make a render deterministic.
 *
 * MIRRORS display_confidence() in migration 20260735.
 */
export function displayConfidence(
  w: ConfidenceInputs,
  now: number = Date.now()
): number {
  let effective = 0;

  if (w.stability != null && w.stability > 0) {
    const anchor = w.lastReviewedDate ?? w.originallyTranslatedDate;
    const elapsedDays =
      anchor == null ? 0 : Math.max(0, (now - Date.parse(anchor)) / MS_PER_DAY);
    const r = Math.exp(-elapsedDays / w.stability);
    effective += w.stability * Math.pow(r, DISPLAY_DECAY_EXPONENT);
  }

  if (w.shortStability != null && w.shortStability > 0 && w.shortStabilityAt != null) {
    const elapsedHours = Math.max(
      0,
      (now - Date.parse(w.shortStabilityAt)) / MS_PER_HOUR
    );
    effective += w.shortStability * Math.pow(0.5, elapsedHours / SHORT_HALF_LIFE_HOURS);
  }

  const bucket = confidenceFromStability(effective);
  return (w.peakConfidence ?? 0) >= 5 ? Math.max(bucket, PEAK_FLOOR) : bucket;
}
