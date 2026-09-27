// =========================================================
// Estimated levels — the client mirror of estimated_band() (migrations 20260777/78).
//
// The curated band (the JLPT list) covers ~8k words. For the rest, a level is ESTIMATED
// from corpus frequency with a rule that leans easy, never goes below N3, and stops at
// Zipf 3.0 — see docs/research/Level_Estimate_Gap_Fill.md. The rule is MEASURED data
// (a small bin table, re-measured by `npm run build:leveling`), so the client fetches the
// table once at startup rather than hardcoding it; only the SHAPE of the rule lives here.
//
// KEEP IN SYNC with the SQL: the bin arithmetic mirrors estimated_band(), and
// isLevelableVocab mirrors not_leveled_vocab(). tests/services/proficiency/estimate.test.ts
// pins both against the migrations.
//
// PURE (no I/O) like the rest of services/proficiency; the one fetch lives in
// loadEstimates.ts. Degrades by construction: until the table loads (or if it never
// does — an un-migrated database, offline, a timeout) every lookup returns null and the
// app shows curated levels only.
// =========================================================
/** Frequency units (Zipf ×100) per bin — half a Zipf. Mirrors estimated_band(). */
export const ESTIMATE_BIN_WIDTH = 50;
/** Bins at and above this are pooled (Zipf 6.0+). Mirrors estimated_band(). */
export const ESTIMATE_TOP_BIN = 12;

/** POS tags that are grammar, affixes or interjections — never a level to estimate.
 *  Mirrors not_leveled_vocab() (20260776). */
export const NOT_LEVELED_POS: ReadonlySet<string> = new Set([
  "prt", "aux", "aux-v", "aux-adj", "cop", "cop-da",
  "pref", "suf", "n-pref", "n-suf", "int",
]);
/** JMdict's proper-name entries (the block brought in from JMnedict). */
export const NAME_ENTRY_MIN = 5_000_000;

/** A sense that has a vocabulary level at all: not grammar / an affix / an interjection
 *  (every POS tag one of those) and not a JMdict name. */
export function isLevelableVocab(partOfSpeech: string[] | null, jmdictEntryId: string | null): boolean {
  if (partOfSpeech && partOfSpeech.length > 0 && partOfSpeech.every((p) => NOT_LEVELED_POS.has(p))) {
    return false;
  }
  if (jmdictEntryId && /^\d+$/.test(jmdictEntryId) && Number(jmdictEntryId) >= NAME_ENTRY_MIN) {
    return false;
  }
  return true;
}

/** language → (bin → band). Empty until loaded. */
let bins = new Map<string, Map<number, number>>();

export interface EstimateBinRow {
  language: string;
  freq_bin: number;
  band: number;
}

/** Install the bin table (from the RPC, or a test). */
export function setLevelEstimateBins(rows: readonly EstimateBinRow[]): void {
  const next = new Map<string, Map<number, number>>();
  for (const r of rows) {
    const m = next.get(r.language) ?? new Map<number, number>();
    m.set(r.freq_bin, r.band);
    next.set(r.language, m);
  }
  bins = next;
}

/** The estimated band for a word's frequency, or null. Mirrors estimated_band(). */
export function estimatedBand(lang: string, frequency: number | null): number | null {
  if (frequency == null) return null;
  const bin = Math.min(Math.floor(frequency / ESTIMATE_BIN_WIDTH), ESTIMATE_TOP_BIN);
  return bins.get(lang)?.get(bin) ?? null;
}
