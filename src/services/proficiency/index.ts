// =========================================================
// Proficiency facade — import from "./proficiency".
//
//   getProficiency(word)          the single read entry point (a word's label)
//   proficiencyFrameworkFor(lang) the framework for a level picker (all its bands)
//   framework.ts                  the ProficiencyFramework type + band helpers
//   registry.ts                   per-language routing (JA→JLPT, EN→CEFR)
//
// PURE / read-time (no I/O), like getDifficulty / furiganaFor: reads only fields
// already on the Word (sourceLang + proficiencyBand, and for the gap-fill estimate its
// frequency / POS / JMdict entry — estimate.ts). The language-specific work
// (the surface→band wordlist) happens once upstream in the JMdict ingest; this is
// only the thin label resolution. Proficiency is the LABEL axis — distinct from
// difficulty (frequency) and relatedness (embeddings); never conflate them.
// =========================================================

import type { LangCode } from "../language";
import { labelForBand, type ProficiencyFramework } from "./framework";
import { resolveFramework } from "./registry";
import { estimatedBand, isLevelableVocab } from "./estimate";

/** A resolved proficiency label for a word. */
export interface Proficiency {
  /** Framework code the band belongs to ("JLPT", "CEFR"). */
  framework: string;
  /** Raw stored band (1 = easiest … ascending = harder). */
  band: number;
  /** Learner-facing label ("N3", "B2"). */
  label: string;
  /** Where the band came from: the curated list, or the frequency estimate that fills
   *  its gaps (estimate.ts). Shown the same; kept apart for logic that must not treat
   *  a guess as the list (e.g. the Learn tab's level pools). */
  source: "curated" | "estimated";
}

/** What getProficiency reads. The last three are optional: a caller without them gets
 *  the curated band only (no estimate), which is always a safe answer. */
export interface ProficiencyTarget {
  sourceLang: LangCode;
  proficiencyBand: number | null;
  frequency?: number | null;
  partOfSpeech?: string[] | null;
  jmdictEntryId?: string | null;
}

/**
 * The proficiency label for a word, or null. The CURATED band wins; without one, a word
 * that is levelable vocabulary (not grammar / an affix / an interjection / a name) gets
 * the frequency ESTIMATE when there is one (estimate.ts — leans easy, never below N3,
 * nothing under Zipf 3.0). Null when the language has no framework, the word has neither,
 * or the band is out of the framework's range. Routes by source language (registry.ts).
 *
 * Accepts any word-like shape (a dictionary `Word` OR a saved `UserWord`).
 *
 * OUTPUT: a Proficiency (with its `source`), or null. PURE — safe to call during render.
 */
export function getProficiency(word: ProficiencyTarget): Proficiency | null {
  const fw = resolveFramework(word.sourceLang);
  if (!fw) return null;
  let band = word.proficiencyBand;
  let source: Proficiency["source"] = "curated";
  if (band == null) {
    if (!isLevelableVocab(word.partOfSpeech ?? null, word.jmdictEntryId ?? null)) return null;
    band = estimatedBand(word.sourceLang, word.frequency ?? null);
    source = "estimated";
  }
  if (band == null) return null;
  const label = labelForBand(fw, band);
  return label == null ? null : { framework: fw.code, band, label, source };
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
export * from "./estimate";
