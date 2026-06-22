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
import { type Difficulty, fromFrequency, fromOverride } from "./level";

export type DifficultyResolver = (word: Word) => Difficulty;

// Zipf × 100 thresholds (higher = more common = easier): ≥500 → L1 (e.g. 行く 552,
// 猫 505), ≥450 → L2, ≥400 → L3, ≥300 → L4, else L5 (rare/hard, e.g. 形而上学 256).
const ZIPF_BINS = [500, 450, 400, 300] as const;

/** Shared resolver: a curated override (JLPT/HSK, future) wins, else bin the Zipf score. */
const frequencyResolver: DifficultyResolver = (w) =>
  fromOverride(w.difficultyOverride) ?? fromFrequency(w.frequency, ZIPF_BINS);

/**
 * Japanese (getDifficultyJapanese): identical to the default today — the Zipf scale
 * is language-neutral — but kept as the explicit per-language seam (e.g. for a
 * JLPT-specific override mapping later).
 */
const japaneseResolver: DifficultyResolver = frequencyResolver;

/** Default for any language: Zipf scores are comparable, so one binning fits all. */
const defaultResolver: DifficultyResolver = frequencyResolver;

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
