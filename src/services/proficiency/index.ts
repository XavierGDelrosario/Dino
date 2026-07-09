// =========================================================
// Proficiency facade — import from "./proficiency".
//
//   getProficiency(word)          the single read entry point (a word's label)
//   proficiencyFrameworkFor(lang) the framework for a level picker (all its bands)
//   framework.ts                  the ProficiencyFramework type + band helpers
//   registry.ts                   per-language routing (JA→JLPT, EN→CEFR)
//
// PURE / read-time (no I/O), like getDifficulty / furiganaFor: reads only fields
// already on the Word (sourceLang + proficiencyBand). The language-specific work
// (the surface→band wordlist) happens once upstream in the JMdict ingest; this is
// only the thin label resolution. Proficiency is the LABEL axis — distinct from
// difficulty (frequency) and relatedness (embeddings); never conflate them.
// =========================================================

import type { LangCode } from "../language";
import { labelForBand, type ProficiencyFramework } from "./framework";
import { resolveFramework } from "./registry";

/** A resolved proficiency label for a word. */
export interface Proficiency {
  /** Framework code the band belongs to ("JLPT", "CEFR"). */
  framework: string;
  /** Raw stored band (1 = easiest … ascending = harder). */
  band: number;
  /** Learner-facing label ("N3", "B2"). */
  label: string;
}

/**
 * The proficiency label for a word, or null when its language has no framework
 * OR the word has no band (the common case until a wordlist is ingested), OR the
 * band is out of the framework's range. Routes to the per-language framework by
 * the word's source language (registry.ts).
 *
 * Reads only `sourceLang` + `proficiencyBand`, so it accepts any word-like shape
 * (a dictionary `Word` OR a saved `UserWord`) — not the full `Word`.
 *
 * OUTPUT: a Proficiency, or null. PURE — safe to call during render.
 */
export function getProficiency(word: {
  sourceLang: LangCode;
  proficiencyBand: number | null;
}): Proficiency | null {
  const fw = resolveFramework(word.sourceLang);
  if (!fw || word.proficiencyBand == null) return null;
  const label = labelForBand(fw, word.proficiencyBand);
  return label == null ? null : { framework: fw.code, band: word.proficiencyBand, label };
}

/**
 * The curated framework for a language (its ordered bands + labels), for building
 * a level picker, or null if the language has none.
 */
export function proficiencyFrameworkFor(lang: LangCode): ProficiencyFramework | null {
  return resolveFramework(lang);
}

export * from "./framework";
export * from "./registry";
