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

// ── Placement level (the "Find my level" swipe quiz) ──────────────────────────
// Derives the band from the user's PLACEMENT ANSWERS — every know / don't-know swipe
// they have ever given (migration 20260769) — accumulated across sessions, so the
// denominator grows and a handful of misses can't swing the result.
//
// It used to read the WHOLE vocabulary instead, which put real N2/N3 learners at N5:
// most saved words were saved BECAUSE the user didn't know them (studying twenty N4
// words added twenty shaky N4 words to the N4 tally), and "known" was the live display
// confidence, which fades on purpose. The quiz's own answers are the only unbiased
// sample, and a word counts as known if it was swiped know OR has since reached a
// long-term confidence of 3 (the migration's placement_evidence). A level is only
// DETERMINED once there is enough coverage; before that the caller shows "keep rating".

/**
 * Answers needed to TRUST a band. Harder bands still need more evidence, but this is a
 * PLACEMENT, not a certification. The quiz deals 5 words per band per fetch, so these
 * are reachable in one sitting; the known-FRACTION (passForBand) is what keeps a lucky
 * streak from buying a band. A thin early read self-corrects as answers accumulate, and
 * the SRS ease a band feeds is capped at 2.5× (migration 20260731) — a wrong band
 * stretches intervals, it cannot retire a word.
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

/** The known-fraction at which a band is worth CREDITING — higher for easier bands, so a
 *  hard placement needs near-complete mastery of the easy ones. In the best-fit below
 *  this is each band's break-even point, not a hard gate. */
const PASS_EASIEST = 0.9;
const PASS_HARDEST = 0.75;
function passForBand(band: number, maxBand: number): number {
  if (maxBand <= 1) return PASS_HARDEST;
  const t = (band - 1) / (maxBand - 1); // 0 easiest … 1 hardest
  return PASS_EASIEST + (PASS_HARDEST - PASS_EASIEST) * t;
}
// For JLPT (5 bands): N5:0.90 · N4:0.86 · N3:0.83 · N2:0.79 · N1:0.75.

/** Answers OVERALL before a level is DETERMINED. Total (not per-band) because the quiz
 *  spends its swipes around the user's current band, so a per-band gate stalls. */
const MIN_TOTAL_WORDS = 10;

export interface PlacementBandStat {
  band: number;
  count: number;
  known: number;
  /** known / count, 0 when count is 0. */
  knownFraction: number;
}

export interface PlacementLevel {
  /** Per-band tallies, easiest → hardest. */
  perBand: PlacementBandStat[];
  /** Placed band: the best-fit TRUSTED band (0 = below all of them). Provisional until
   *  `sufficient`. */
  band: number;
  /** Difficulty-axis level (users.level), via estimateLevel over the same answers. */
  level: LevelValue | null;
  /** Enough coverage to commit a level (vs. show "keep rating"). */
  sufficient: boolean;
  /** Rough number of extra answers to reach sufficiency (0 when sufficient). */
  needMore: number;
}

/** One placement answer reduced to what the level calc needs. */
export interface PlacementRating {
  band: number | null; // proficiency band (framework ordinal), null if unbanded
  difficulty: LevelValue | null; // frequency difficulty (getDifficulty), null if unknown
  known: boolean;
}

/**
 * Place the user from their answers. PURE.
 *
 * BEST FIT, not "stop at the first miss". The old walk climbed easiest → hardest and
 * stopped at the first trusted band under its bar, so one shaky band hid every band
 * above it (N5 38/40, N4 25/30, N3 10/10, N2 14/14 → N5). Instead, every candidate
 * placement L (0, or a trusted band) is scored against ALL trusted bands:
 *
 *   cost(L) = Σ_{b ≤ L} unknown_b · pass_b  +  Σ_{b > L} known_b · (1 − pass_b)
 *
 * i.e. an unknown word in a band we credit costs its bar, a known word in a band we
 * don't credit costs the remainder. The weights are the per-band bars, so for any ONE
 * band this reduces exactly to "credit it iff known/count ≥ pass" — the old rule, tie
 * included — and across bands the evidence is weighed rather than truncated. Lowest cost
 * wins. Untrusted bands (too few answers) contribute nothing, as before.
 */
export function levelFromRatings(ratings: PlacementRating[], maxBand: number): PlacementLevel {
  const acc = new Map<number, { count: number; known: number }>();
  for (const r of ratings) {
    if (r.band == null) continue;
    const a = acc.get(r.band) ?? { count: 0, known: 0 };
    a.count += 1;
    if (r.known) a.known += 1;
    acc.set(r.band, a);
  }

  const perBand: PlacementBandStat[] = [];
  for (let b = 1; b <= maxBand; b++) {
    const a = acc.get(b);
    const count = a?.count ?? 0;
    const known = a?.known ?? 0;
    perBand.push({ band: b, count, known, knownFraction: count ? known / count : 0 });
  }

  const trusted = perBand.filter((s) => s.count >= minWordsForBand(s.band, maxBand));
  const cost = (placed: number) =>
    trusted.reduce((sum, s) => {
      const pass = passForBand(s.band, maxBand);
      return sum + (s.band <= placed ? (s.count - s.known) * pass : s.known * (1 - pass));
    }, 0);

  let band = 0;
  let best = cost(0);
  for (const s of trusted) {
    const c = cost(s.band);
    // A tie credits the band, matching the ≥ bar. The epsilon absorbs float noise in the
    // weights (9 × 0.1 is not exactly 1 × 0.9), so an exact tie can't go either way by rounding.
    if (c <= best + 1e-9) {
      best = c;
      band = s.band;
    }
  }

  // Answers from earlier sessions count toward sufficiency, so a returning user is
  // placeable almost immediately.
  const totalRated = perBand.reduce((n, s) => n + s.count, 0);
  const needMore = Math.max(0, MIN_TOTAL_WORDS - totalRated);
  const sufficient = needMore === 0;

  // The difficulty axis keeps its own conservative walk; a swipe is binary, so it maps
  // to the grade scale's ends.
  const level = estimateLevel(
    ratings
      .filter((r): r is PlacementRating & { difficulty: LevelValue } => r.difficulty != null)
      .map((r) => ({ difficulty: r.difficulty, grade: (r.known ? 5 : 1) as ReviewGrade })),
  );

  return { perBand, band, level, sufficient, needMore };
}

/** getDifficulty over an answer's cache fields (it only reads sourceLang + the
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

/** A database that hasn't taken migration 20260769 yet: PostgREST can't find the
 *  function (PGRST202) / table (PGRST205), or Postgres can't (42883 / 42P01). */
const isMissingPlacementSchema = (error: { code?: string } | null): boolean =>
  ["PGRST202", "PGRST205", "42883", "42P01"].includes(error?.code ?? "");

/**
 * The user's placement answers for `learning`, reduced to level-calc inputs, or null
 * when the language has no proficiency framework. The swipe quiz fetches this ONCE as a
 * baseline, then appends each swipe locally and re-runs levelFromRatings in memory.
 *
 * DEGRADES on an un-migrated database: no history, so the quiz places from this
 * session's swipes alone instead of failing to open.
 */
export async function getPlacementRatings(
  learning: LangCode,
): Promise<{ ratings: PlacementRating[]; maxBand: number } | null> {
  const fw = proficiencyFrameworkFor(learning);
  if (!fw) return null;
  const maxBand = fw.bands[fw.bands.length - 1]?.value ?? 1;
  // No user argument: the function scopes to auth.uid(), so it can only ever read
  // the caller's own answers.
  const { data, error } = await supabase.rpc("placement_evidence", { p_source_lang: learning });
  if (error) {
    if (isMissingPlacementSchema(error)) {
      console.warn("calibration: placement_evidence unavailable (migration 20260769 not applied)");
      return { ratings: [], maxBand };
    }
    throw toServiceError(error);
  }
  const ratings: PlacementRating[] = (data ?? []).map((r) => ({
    band: r.band,
    difficulty: difficultyOf({ sourceLang: learning, frequency: r.frequency, proficiencyBand: r.band }),
    known: r.known,
  }));
  return { ratings, maxBand };
}

/** Record one swipe. A later answer on the same word replaces the earlier one.
 *  Throws on failure; the quiz treats it as fire-and-forget. */
export async function recordPlacementAnswer(opts: {
  userId: string;
  wordId: string;
  known: boolean;
}): Promise<void> {
  const { error } = await supabase.from("placement_answers").upsert(
    { user_id: opts.userId, word_id: opts.wordId, known: opts.known, answered_at: new Date().toISOString() },
    { onConflict: "user_id,word_id" },
  );
  if (error) throw toServiceError(error);
}
