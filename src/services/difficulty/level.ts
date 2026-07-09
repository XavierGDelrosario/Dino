// =========================================================
// Difficulty levels + the two signal→level mappings.
//
// The DIFFICULTY AXIS is corpus frequency (a universal level scale that needs no
// JLPT-style ranking) refined by a curated override where one exists. This file
// holds the pure mapping primitives; registry.ts wires them per language and
// index.ts is the getDifficulty() facade. (Difficulty is ONE axis — relatedness
// is the separate embeddings axis, never conflated here.)
// =========================================================

export type LevelValue = 1 | 2 | 3 | 4 | 5; // 1 = easiest … 5 = hardest
export type DifficultySource = "override" | "proficiency" | "frequency" | "none";

/** A resolved difficulty: the level plus which signal produced it (for UX/debug). */
export interface Difficulty {
  level: LevelValue | null; // null = unrated (no frequency, no override)
  source: DifficultySource;
}

export const UNKNOWN_DIFFICULTY: Difficulty = { level: null, source: "none" };

function clampLevel(n: number): LevelValue {
  return Math.min(5, Math.max(1, Math.round(n))) as LevelValue;
}

/**
 * A curated, already-NORMALIZED 1..5 override (JLPT N5→1 … N1→5, HSK, …), or null
 * when the word has none. When present it WINS over frequency — the authoritative
 * source refines the approximate one, same "authoritative-with-fallback" shape as
 * verified readings vs kuromoji.
 */
export function fromOverride(override: number | null): Difficulty | null {
  return override == null ? null : { level: clampLevel(override), source: "override" };
}

/**
 * Normalize a curated PROFICIENCY band to the 1..5 difficulty scale. The band is
 * framework-relative and ascending = harder (JLPT N5→1…N1→5; CEFR A1→1…C2→6), so a
 * framework with `bandCount` bands maps linearly onto 1..5: JLPT (5) is the identity;
 * CEFR (6) compresses. NULL band / empty framework → null (defer to frequency).
 *
 * WHY this WINS over frequency where present (see docs/TODO leveling note): corpus
 * frequency measures COMMONNESS, not learner LEVEL — a frequent-but-abstract word
 * (的 is ~12th-most-frequent kanji yet N3) is not beginner. The curated JLPT/CEFR
 * level is the RIGHT axis for "how hard for a learner", approximate but correct in
 * kind; frequency is the dense proxy only for the ~96% of words that HAVE no band.
 */
export function fromProficiencyBand(band: number | null, bandCount: number): Difficulty | null {
  if (band == null || bandCount < 1 || band < 1 || band > bandCount) return null;
  const level = bandCount <= 1 ? 3 : clampLevel(1 + ((band - 1) / (bandCount - 1)) * 4);
  return { level, source: "proficiency" };
}

/**
 * Bin a corpus-frequency SCORE (wordfreq Zipf × 100; HIGHER = more common = easier)
 * into a 1..5 difficulty via N DESCENDING thresholds: score ≥ thresholds[0] → 1
 * (easiest), ≥ thresholds[1] → 2, … else N+1 (hardest). Pass 4 thresholds for a
 * 1..5 scale. NULL score → unknown. Zipf is normalized + cross-language-comparable,
 * so the same thresholds apply to any language's score.
 */
export function fromFrequency(
  freq: number | null,
  thresholds: readonly number[],
): Difficulty {
  if (freq == null) return UNKNOWN_DIFFICULTY;
  let level = 1;
  for (const t of thresholds) {
    if (freq >= t) break;
    level++;
  }
  return { level: clampLevel(level), source: "frequency" };
}
