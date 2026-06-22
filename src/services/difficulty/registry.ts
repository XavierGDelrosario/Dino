// =========================================================
// Difficulty resolver registry — routes a language to its frequency binning.
//
// Mirrors services/senses/registry.ts: a per-language strategy with a default
// fallback. What legitimately varies BY LANGUAGE is the frequency SCALE (JMdict's
// nfXX is 1..48; another dictionary's corpus list will differ), so each language
// owns its bin thresholds. The override step is universal, so it lives in the
// shared resolver shape, not per language. JMdict is the only frequency source
// today, so the default reuses its bins — register a resolver here when a second
// language ships a different scale.
// =========================================================

import type { LangCode } from "../language";
import type { Word } from "../words/repository";
import { type Difficulty, fromFrequency, fromOverride } from "./level";

export type DifficultyResolver = (word: Word) => Difficulty;

// JMdict nfXX rank is 1..48 (lower = more common). ~10-wide bins → a 1..5 scale.
const JMDICT_FREQUENCY_BINS = [10, 20, 30, 40] as const;

/**
 * Japanese (getDifficultyJapanese): a curated override (future JLPT) wins, else
 * bin the JMdict nfXX frequency. The explicit per-language seam.
 */
const japaneseResolver: DifficultyResolver = (w) =>
  fromOverride(w.difficultyOverride) ?? fromFrequency(w.frequency, JMDICT_FREQUENCY_BINS);

/**
 * Default for any unregistered language. JMdict (nfXX) is currently the only
 * frequency source so it reuses those bins — which also keeps EN→JA words (whose
 * sourceLang is EN but whose stored frequency is the JA entry's nfXX rank) rated.
 * A language with a different scale registers its own resolver above.
 */
const defaultResolver: DifficultyResolver = japaneseResolver;

interface ResolverEntry {
  supports(lang: LangCode): boolean;
  resolve: DifficultyResolver;
}

const RESOLVERS: ResolverEntry[] = [
  { supports: (l) => l === "JA", resolve: japaneseResolver },
];

/**
 * Picks the difficulty resolver for a language.
 * OUTPUT: the matching resolver, or the default (JMdict-scale) fallback.
 */
export function resolveDifficultyResolver(sourceLang: LangCode): DifficultyResolver {
  return RESOLVERS.find((e) => e.supports(sourceLang))?.resolve ?? defaultResolver;
}
