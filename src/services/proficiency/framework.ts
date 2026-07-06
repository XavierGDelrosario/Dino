// =========================================================
// Proficiency frameworks — the curated, per-language PROFICIENCY LABEL axis
// (JLPT / CEFR / HSK …). A proficiency band is an authoritative, learner-facing
// LABEL, NOT a computed difficulty. Kept SEPARATE from the two other axes and
// never conflated:
//   * DIFFICULTY  — corpus frequency (services/difficulty). Computed, universal.
//   * RELATEDNESS — word embeddings (services/embeddings). Semantic.
//
// The whole point is that a framework is ONE generic concept — a named, ORDERED
// set of bands for one language — so adding a language's scale is DATA (a registry
// entry + an ingest wordlist), never new code. The only language-specific part is
// the surface→band wordlist, which lives in data/proficiency + the JMdict ingest
// join, exactly like frequency.
//
// CONVENTION (load-bearing): the stored `proficiency_band` INT is ALWAYS
// ascending = HARDER, regardless of how the framework labels itself. JLPT labels
// count DOWN (N5 easy → N1 hard), so we list bands easiest-first and ingest maps
// N5→1 … N1→5. CEFR/HSK count up (A1/HSK1 → 1). So the raw integer is a valid
// per-language difficulty ordering with NO normalization — cross-language
// comparison (the only thing normalization would buy) is a read-time concern, not
// stored. Frameworks differ in band COUNT (JLPT 5, CEFR/HSK 6) — that count is
// data here, never a shared assumption.
// =========================================================

/** One band of a framework: its stored ordinal (1 = easiest) + display label. */
export interface ProficiencyBand {
  /** Stored `proficiency_band` value — 1 = easiest, ascending = harder. */
  value: number;
  /** Learner-facing label ("N5", "B2", "HSK 3"). */
  label: string;
}

/** A curated proficiency scale for one language (JLPT, CEFR, …). */
export interface ProficiencyFramework {
  /** Stable code ("JLPT", "CEFR", "HSK") — identity, not shown raw. */
  code: string;
  /** Human name for UI (a level picker heading). */
  name: string;
  /** Bands ordered EASIEST → HARDEST; `value` ascends 1..n with difficulty. */
  bands: ProficiencyBand[];
}

/**
 * Build a framework's bands from labels listed EASIEST → HARDEST. Assigns
 * value = index + 1, enforcing the ascending-is-harder convention by construction:
 * pass JLPT as ["N5".."N1"] and CEFR as ["A1".."C2"].
 */
export function bandsFromLabels(labelsEasiestFirst: readonly string[]): ProficiencyBand[] {
  return labelsEasiestFirst.map((label, i) => ({ value: i + 1, label }));
}

/** The display label for a raw band value, or null if it isn't in the framework. */
export function labelForBand(fw: ProficiencyFramework, band: number | null): string | null {
  if (band == null) return null;
  return fw.bands.find((b) => b.value === band)?.label ?? null;
}
