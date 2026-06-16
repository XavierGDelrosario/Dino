// =========================================================
// Word segmentation for paragraph input.
//
// Uses Intl.Segmenter, which word-segments scripts WITHOUT spaces (Japanese)
// as well as spaced ones (English) — the only dependency-free way to do this
// in the browser. Falls back to a Unicode word regex if Segmenter is missing
// (older runtimes); that fallback only works for spaced languages.
//
// Each token carries its offsets so a translation can be mapped back to the
// exact place it came from — essential when a word repeats or has multiple
// meanings (you map by position, not by matching translation text).
//
// CONSTRAINTS: assumes input is one language at a time, and that the language is supported by our registry.
// =========================================================

import type { LangCode } from "./registry";

export interface WordToken {
  /** The word exactly as it appears in the source text. */
  text: string;
  /** Start offset in the source text (inclusive). */
  start: number;
  /** End offset in the source text (exclusive). */
  end: number;
}

// Minimal typing for Intl.Segmenter (absent from older TS libs); feature-detected.
type WordSegment = { segment: string; index: number; isWordLike?: boolean };
interface SegmenterLike {
  segment(input: string): Iterable<WordSegment>;
}
type SegmenterCtor = new (
  locales?: string,
  options?: { granularity?: "grapheme" | "word" | "sentence" }
) => SegmenterLike;

const Segmenter = (Intl as unknown as { Segmenter?: SegmenterCtor }).Segmenter;

/**
 * Splits `text` into word tokens (with offsets) for the given language.
 * Punctuation and whitespace are dropped; only word-like segments are kept.
 *
 * OUTPUT: WordToken[] — each with text + [start, end) offsets into `text`.
 * CONSTRAINTS: uses Intl.Segmenter; the regex fallback only segments spaced
 * languages; assumes `text` is a single supported language.
 */
export function tokenizeWords(text: string, lang: LangCode): WordToken[] {
  if (Segmenter) {
    const segmenter = new Segmenter(lang.toLowerCase(), { granularity: "word" });
    const tokens: WordToken[] = [];
    for (const seg of segmenter.segment(text)) {
      if (seg.isWordLike) {
        tokens.push({
          text: seg.segment,
          start: seg.index,
          end: seg.index + seg.segment.length,
        });
      }
    }
    return tokens;
  }

  // Fallback: Unicode word matcher. Works for spaced languages only — a
  // space-less Japanese run would come back as a single token.
  const tokens: WordToken[] = [];
  const re = /[\p{L}\p{N}][\p{L}\p{N}\p{M}'-]*/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    tokens.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  }
  return tokens;
}
