// =========================================================
// Difficulty resolver registry — routes a language to its frequency binning.
//
// Mirrors services/senses/registry.ts: a per-language strategy with a default
// fallback. Frequency is a wordfreq Zipf score (× 100), which is NORMALIZED and
// cross-language-comparable, so a SINGLE set of bin thresholds works for every
// language — the default resolver handles all of them. The per-language seam
// remains for genuine divergence (e.g. a language that needs different thresholds
// or a curated-override mapping), exactly like the empty senses/ registry.
// =========================================================

import type { LangCode } from "../language";
import type { Word } from "../words/repository";
import { proficiencyFrameworkFor } from "../proficiency";
import { type Difficulty, fromFrequency, fromOverride, fromProficiencyBand } from "./level";

export type DifficultyResolver = (word: Word) => Difficulty;

// Zipf × 100 thresholds (higher = more common = easier): ≥500 → L1 (e.g. 行く 552,
// 猫 505), ≥450 → L2, ≥400 → L3, ≥300 → L4, else L5 (rare/hard, e.g. 形而上学 256).
const ZIPF_BINS = [500, 450, 400, 300] as const;

/**
 * Curated proficiency LEVEL for a word, normalized to 1..5 — or null when the word
 * has no band (or its language no framework). Reads the band straight off the Word +
 * the framework's band count; getProficiency (the LABEL resolver) isn't needed here.
 */
function fromProficiency(w: Word): Difficulty | null {
  const fw = proficiencyFrameworkFor(w.sourceLang);
  return fw ? fromProficiencyBand(w.proficiencyBand, fw.bands.length) : null;
}

/**
 * Shared resolver — precedence: explicit manual override (JLPT/HSK-curated, NULL
 * today) → the curated PROFICIENCY level (JLPT/CEFR; the RIGHT axis for "how hard for
 * a learner") → the Zipf frequency bin (dense COMMONNESS proxy, for the ~96% of words
 * with no curated band). "Authoritative-with-fallback", never a blend — frequency ≠
 * level (see docs/TODO leveling note), so a curated level wins wherever it exists.
 */
const composedResolver: DifficultyResolver = (w) =>
  fromOverride(w.difficultyOverride) ?? fromProficiency(w) ?? fromFrequency(w.frequency, ZIPF_BINS);

/**
 * Japanese (getDifficultyJapanese): identical to the default — the same precedence
 * works for every language (proficiency routes by framework, Zipf is language-neutral).
 * Kept as the explicit per-language seam for genuine future divergence.
 */
const japaneseResolver: DifficultyResolver = composedResolver;

/** Default for any language: Zipf scores are comparable, so one binning fits all. */
const defaultResolver: DifficultyResolver = composedResolver;

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
