// Level calibration (#10) — estimate a user's level from quiz results and seed the SRS
// so their known words don't all cold-start at 0.
//
// The estimate is deliberately CONSERVATIVE, biased to UNDER-rate, because the error is
// asymmetric: under-rating surfaces a word a little more often (cheap, self-correcting),
// while over-rating can hide a word the user needs to see.
//
// Source-agnostic: samples can come from a pasted paragraph or a difficulty-sampled set.
// Difficulty per word comes from services/difficulty; the grade is the same 1..5
// self-rated recall the SRS uses.

import { supabase } from "../config/supabaseClient";
import { toServiceError } from "./errors";
import { getDifficulty, type LevelValue } from "./difficulty";
import { getAllUserWords } from "./words/userWords";
import { proficiencyFrameworkFor } from "./proficiency";
import type { LangCode } from "./language";
import type { Word } from "./words/repository";
import type { ReviewGrade } from "./review";

/** One graded calibration item: a word's difficulty paired with how the user did. */
export interface CalibrationSample {
  /** The word's difficulty 1..5 (from getDifficulty). */
  difficulty: LevelValue;
  /** The user's 1..5 self-rated recall for it. */
  grade: ReviewGrade;
}

/** Grade ≥ this counts as "recalled" — matches record_review's lapse cutoff. */
const RECALLED_GRADE = 3;
/** Recall fraction a level must clear to be credited. High on purpose: the user must
 *  CLEARLY know a level, which biases the estimate down. */
const PASS_THRESHOLD = 0.75;

/**
 * Estimate the user's level (1..5), or null when there's nothing to credit. Walks
 * levels 1→5: skips untested ones, credits a tested level clearing PASS_THRESHOLD, and
 * STOPS at the first tested failure — never extrapolating above what was tested.
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
// A DIFFERENT path from estimateLevel: instead of grading a fixed paragraph it searches
// the proficiency bands. Each round batches words at one band; knowing ≥
// CALIBRATION_TARGET of them passes the band and the search goes harder, else easier.
// The result is the HARDEST band passed.
//
// STABILITY OVER REACH — a band is decided on a SMALL sample, so one unlucky word used
// to flip it and swing the stored level two bands. Three dampers, increasing in
// importance: a BORDERLINE batch is re-tested once and decided on the POOLED sample;
// with a PRIOR the search spans only prior ± 1; and the result is CLAMPED to prior ± 1
// regardless. A user who genuinely jumped two levels gets there by retaking — being
// wrong upward (words silently never surfacing) is far worse than being wrong downward.
//
// PURE state machine: the hook owns fetching/answers, this owns the search. Bands are
// the framework ordinal (1 = easiest), clamped to the 1..5 users.level scale.

/** Fraction of a batch the user must know for a band to count as "passed". */
export const CALIBRATION_TARGET = 0.8;

/** A known-fraction this close to CALIBRATION_TARGET is a coin-flip, not a verdict, so
 *  the band gets one confirming batch and is decided on the POOLED sample. (In a 12-word
 *  batch both 9/12 and 10/12 land here — the one-word swings that moved a whole band.) */
export const BORDERLINE_MARGIN = 0.15;

/** Search cursor over bands 1..maxBand. `band` is the one to test now, `best` the
 *  hardest passed so far (0 = none), `prior` the user's stored band bounding how far
 *  this calibration may move them (null = first time), and `pooled` carries an
 *  inconclusive batch's counts into the confirming round at the same band. */
export interface BandSearch {
  lo: number;
  hi: number;
  best: number;
  band: number;
  prior: number | null;
  pooled?: { known: number; total: number };
}

/**
 * Begin a search over bands 1..maxBand. Without a `prior` this is a plain binary search
 * from the middle band; with one it searches ONLY prior ± 1 starting AT the prior, so a
 * re-calibration confirms-or-nudges rather than re-guessing from scratch.
 */
export function startBandSearch(maxBand: number, prior: number | null = null): BandSearch {
  const max = Math.max(1, maxBand);
  const lo = prior == null ? 1 : Math.max(1, prior - 1);
  const hi = prior == null ? max : Math.min(max, prior + 1);
  const band = prior == null ? Math.floor((lo + hi) / 2) : Math.min(hi, Math.max(lo, prior));
  return { lo, hi, best: 0, band, prior };
}

/**
 * The level a calibration may record: the measured band, clamped to 1..5 AND to within
 * one band of the `prior`. A measured 0 (failed every band tested) means "below
 * everything we tried" → one band below the prior, or 1 on a first calibration.
 */
export function resolveLevelMove(measured: number, prior: number | null): LevelValue {
  const target = measured > 0 ? measured : (prior ?? 1) - 1;
  const lo = prior == null ? 1 : prior - 1;
  const hi = prior == null ? 5 : prior + 1;
  return Math.min(5, Math.max(1, Math.min(hi, Math.max(lo, target)))) as LevelValue;
}

/**
 * Fold one round's result into the search. Returns the next band to test — possibly the
 * SAME band, when the batch was too close to call — or the final level once the search
 * converges (lo > hi), clamped by resolveLevelMove.
 */
export function advanceBandSearch(
  s: BandSearch,
  known: number,
  total: number,
): { done: true; level: LevelValue } | { done: false; search: BandSearch } {
  const pooledKnown = (s.pooled?.known ?? 0) + known;
  const pooledTotal = (s.pooled?.total ?? 0) + total;
  const fraction = pooledTotal > 0 ? pooledKnown / pooledTotal : 0;

  // Too close to call and not yet confirmed → re-test and decide on the pooled sample.
  // Only ever ONE confirming round per band (`pooled` is set by then), so it can't loop.
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

/** Initial memory strength (days) for a pre-known word, indexed by how far BELOW the
 *  shaded user level it sits. Small on purpose, so an over-credit only lengthens the
 *  first interval slightly rather than hiding the word. */
const SEED_STABILITY_BY_GAP = [1.5, 3.5, 7.0] as const;

/**
 * Initial `stability` (days) for a freshly-added, UN-quizzed word, or null to cold-start.
 * CONSERVATIVE: treats the user as one level lower and seeds only words at/below that
 * shaded level, so a wrong estimate errs toward "review sooner", never "never review".
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

/** The user's stored level estimate (1..5), or null if never calibrated. */
export async function getUserLevel(userId: string): Promise<LevelValue | null> {
  const { data, error } = await supabase
    .from("users")
    .select("level")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw toServiceError(error);
  return (data?.level ?? null) as LevelValue | null;
}

/** Persists the user's level estimate (null clears it). Own-row UPDATE. */
export async function setUserLevel(userId: string, level: LevelValue | null): Promise<void> {
  const { error } = await supabase.from("users").update({ level }).eq("user_id", userId);
  if (error) throw toServiceError(error);
}

// ── Proficiency band (the SEPARATE proficiency axis) ───────────────────────
// users.proficiency_band holds the placement quiz's JLPT/CEFR band, DISTINCT from
// users.level (difficulty/frequency) — kept apart so the consumers of `level` never see
// a band, and vice versa. The ordinal is framework-relative (1 = easiest);
// services/proficiency maps it to a label.

/** The user's stored proficiency band, or null if never calibrated. */
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

// ── Vocabulary-based level (the accurate, STABLE placement) ─────────────────
// Derives the level from the user's WHOLE rated vocabulary — per band, how many words
// they have and how many they know — rather than one small round. The large denominator
// is the point: missing 10 of 100 known N2 words barely moves the fraction, so it can't
// demote you, and evidence ACCUMULATES across sessions. A level is only DETERMINED once
// there is enough coverage; before that the caller shows a provisional "keep rating".

/**
 * Words needed to TRUST a band. Harder bands still need more evidence, but this is a
 * PLACEMENT, not a certification.
 *
 * WAS [8, 12, 19, 70, 130], which put the top two bands out of reach in practice. The
 * quiz draws 5 words per band per fetch, so 70 rated N2 words is ~14 fetches and 130
 * N1 words ~26 — hundreds of swipes before either band could even be considered, and
 * until then it is SKIPPED, so a genuine N1 speaker kept being told they were N3. The
 * cliff between N3 (19) and N2 (70) had no basis; it was caution, not measurement.
 *
 * VOLUME is what made it slow; the known-FRACTION is what makes it accurate — so this
 * relaxes only the volume and leaves passForBand untouched. N2 still means clearing
 * 0.79 over 14 words (≥12 of 14), which no lucky streak reaches by accident.
 *
 * The residual risk is over-placement from a small sample, and it is bounded on both
 * sides: the estimate keeps re-running over the user's WHOLE vocabulary as it grows,
 * so a thin early read self-corrects, and the SRS ease it feeds is capped at 2.5×
 * (migration 20260731) — a wrong band stretches intervals, it cannot retire a word.
 */
const TRUST_JLPT = [5, 7, 10, 14, 18]; // N5 · N4 · N3 · N2 · N1
function minWordsForBand(band: number, maxBand: number): number {
  if (maxBand === TRUST_JLPT.length) return TRUST_JLPT[band - 1] ?? TRUST_JLPT[TRUST_JLPT.length - 1];
  if (maxBand <= 1) return TRUST_JLPT[0];
  const lo = TRUST_JLPT[0];
  const hi = TRUST_JLPT[TRUST_JLPT.length - 1];
  const t = (band - 1) / (maxBand - 1); // 0 easiest … 1 hardest
  return Math.round(lo * Math.pow(hi / lo, t));
}

/** The known-fraction a band must clear to be CREDITED — HIGHER for easier bands, so
 *  reaching a hard level requires near-complete mastery of the easy ones. */
const PASS_EASIEST = 0.9;
const PASS_HARDEST = 0.75;
function passForBand(band: number, maxBand: number): number {
  if (maxBand <= 1) return PASS_HARDEST;
  const t = (band - 1) / (maxBand - 1); // 0 easiest … 1 hardest
  return PASS_EASIEST + (PASS_HARDEST - PASS_EASIEST) * t;
}
// For JLPT (5 bands): N5:0.90 · N4:0.86 · N3:0.83 · N2:0.79 · N1:0.75.

/** Rated words OVERALL before a level is DETERMINED. Total (not per-band) because
 *  vocab is lopsided — most words are common — so a per-band gate stalls forever.
 *  15 → 10: this only gates when the quiz stops saying "keep rating" and commits a
 *  first answer, and the answer keeps sharpening afterwards either way. Getting a
 *  provisional level 5 swipes sooner is worth more than a marginally firmer first read
 *  nobody stayed long enough to see. */
const MIN_TOTAL_WORDS = 10;

export interface VocabBandStat {
  band: number;
  count: number;
  known: number; // confidence ≥ RECALLED_GRADE
  avgConfidence: number; // 0 when count is 0
}

export interface VocabLevel {
  /** Per-band tallies, easiest → hardest. */
  perBand: VocabBandStat[];
  /** Placed band: the highest TRUSTED band whose known-fraction clears the bar
   *  (0 = below all trusted bands). Provisional until `sufficient`. */
  band: number;
  /** Difficulty-axis level (users.level), via estimateLevel over the same vocab. */
  level: LevelValue | null;
  /** Enough coverage to commit a level (vs. show "keep rating"). */
  sufficient: boolean;
  /** Rough number of extra rated words to reach sufficiency (0 when sufficient). */
  needMore: number;
}

/** One rated word reduced to what the level calc needs. */
export interface VocabRating {
  band: number | null; // proficiency band (framework ordinal), null if unbanded
  difficulty: LevelValue | null; // frequency difficulty (getDifficulty), null if unknown
  confidence: number; // 0..5 displayed confidence
}

/**
 * Determine a level from the user's whole rated vocabulary. PURE. Walks bands
 * easiest→hardest: SKIPS one with too few words, CREDITS a trusted band clearing its
 * bar, STOPS at the first trusted failure. Stable by construction — the fraction is
 * over ALL their words at that band, so a handful of misses can't demote them.
 */
export function levelFromVocab(ratings: VocabRating[], maxBand: number): VocabLevel {
  const acc = new Map<number, { count: number; known: number; confSum: number }>();
  for (const r of ratings) {
    if (r.band == null) continue;
    const a = acc.get(r.band) ?? { count: 0, known: 0, confSum: 0 };
    a.count += 1;
    if (r.confidence >= RECALLED_GRADE) a.known += 1;
    a.confSum += r.confidence;
    acc.set(r.band, a);
  }

  const perBand: VocabBandStat[] = [];
  for (let b = 1; b <= maxBand; b++) {
    const a = acc.get(b);
    perBand.push({
      band: b,
      count: a?.count ?? 0,
      known: a?.known ?? 0,
      avgConfidence: a && a.count ? a.confSum / a.count : 0,
    });
  }

  // TRUSTED bands only: harder bands need MORE words, easier bands a HIGHER known%.
  let band = 0;
  for (const s of perBand) {
    if (s.count < minWordsForBand(s.band, maxBand)) continue; // too little evidence → skip
    if (s.known / s.count < passForBand(s.band, maxBand)) break; // not mastered enough → stop
    band = s.band; // trusted + mastered → credit, keep going
  }

  // Existing vocabulary counts toward sufficiency, so a returning user is placeable
  // almost immediately.
  const totalRated = perBand.reduce((n, s) => n + s.count, 0);
  const needMore = Math.max(0, MIN_TOTAL_WORDS - totalRated);
  const sufficient = needMore === 0;

  const level = estimateLevel(
    ratings
      .filter((r): r is VocabRating & { difficulty: LevelValue } => r.difficulty != null)
      .map((r) => ({
        difficulty: r.difficulty,
        grade: Math.max(1, Math.min(5, Math.round(r.confidence))) as ReviewGrade,
      })),
  );

  return { perBand, band, level, sufficient, needMore };
}

/** getDifficulty over a saved word's fields (it only reads sourceLang + the three
 *  difficulty inputs; the rest are placeholder). */
function difficultyOf(w: { sourceLang: LangCode; frequency: number | null; proficiencyBand: number | null }): LevelValue | null {
  return getDifficulty({
    wordId: "",
    input: "",
    translation: "",
    sourceLang: w.sourceLang,
    targetLang: w.sourceLang,
    inputReading: null,
    translationReading: null,
    partOfSpeech: null,
    frequency: w.frequency,
    difficultyOverride: null,
    proficiencyBand: w.proficiencyBand,
    jmdictEntryId: null,
    jmdictSensePos: null,
    isVerified: true,
  } as Word).level;
}

/**
 * The user's whole rated vocabulary reduced to level-calc inputs, or null when the
 * learning language has no proficiency framework. The swipe placement fetches this ONCE
 * as a baseline, then appends each swipe locally and re-runs levelFromVocab in memory.
 */
export async function getVocabRatings(
  userId: string,
  learning: LangCode,
): Promise<{ ratings: VocabRating[]; maxBand: number } | null> {
  const fw = proficiencyFrameworkFor(learning);
  if (!fw) return null;
  const maxBand = fw.bands[fw.bands.length - 1]?.value ?? 1;
  const words = await getAllUserWords({ userId });
  const ratings: VocabRating[] = words
    .filter((w) => w.sourceLang === learning)
    .map((w) => ({ band: w.proficiencyBand, difficulty: difficultyOf(w), confidence: w.confidenceRating }));
  return { ratings, maxBand };
}

/** The whole rated vocabulary folded through levelFromVocab, or null when the learning
 *  language has no proficiency framework. */
export async function getVocabLevel(userId: string, learning: LangCode): Promise<VocabLevel | null> {
  const base = await getVocabRatings(userId, learning);
  return base ? levelFromVocab(base.ratings, base.maxBand) : null;
}
