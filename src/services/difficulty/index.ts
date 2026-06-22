// =========================================================
// Difficulty facade — import from "./difficulty".
//
//   getDifficulty(word)  the single entry point
//   level.ts             Difficulty type + the signal→level mappings
//   registry.ts          per-language resolver routing (getDifficultyJapanese)
// =========================================================

import type { Word } from "../words/repository";
import type { Difficulty } from "./level";
import { resolveDifficultyResolver } from "./registry";

/**
 * The resolved difficulty of a dictionary word: a curated override (JLPT/HSK) if
 * present, else its corpus-frequency level, else unknown. Routes to a per-language
 * resolver (registry.ts) keyed on the word's source language.
 *
 * PURE — reads only fields already on the Word (frequency / difficultyOverride /
 * sourceLang), no I/O. Safe to call during render, like furiganaFor / retrievability.
 * The heavy work (parsing nfXX) happens once upstream in the JMdict ingest; this is
 * only the thin read-time resolution, the same split as translate's backend facade.
 */
export function getDifficulty(word: Word): Difficulty {
  return resolveDifficultyResolver(word.sourceLang)(word);
}

export * from "./level";
export * from "./registry";
