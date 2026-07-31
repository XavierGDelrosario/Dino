// =========================================================
// Transcript merge (PURE, tested).
//
// A live transcript is analyzed APPEND-ONLY: each utterance is looked up once, as
// it commits, and never again. Re-analyzing the whole transcript on every new line
// would be quadratic and would re-look-up every word already resolved — over an
// hour of conversation that is the difference between free and unusable.
//
// But the reader renders ONE document: it slices its `text` by token offsets to
// print the punctuation and spacing between tokens. So the per-utterance analyses
// have to be presented as a single text with a single token list, which is what
// this does — join the utterances, shift each block's offsets by where its text
// landed, and union the meaning maps.
//
// Analysis stays per-utterance; only the VIEW is merged.
// =========================================================

import type { AnalyzedToken } from "../language";
import type { Word } from "../words/repository";

export interface TranscriptBlock {
  /** The utterance as recognized. */
  text: string;
  /** Its analysis — tokens with offsets into `text`, and that block's meanings. */
  tokens: AnalyzedToken[];
  meanings: Map<string, Word[]>;
}

export interface MergedTranscript {
  /** Every utterance joined, one per line. */
  text: string;
  /** All tokens, offsets rebased onto `text`. */
  tokens: AnalyzedToken[];
  /** Union of the per-block meaning maps (same surface → same senses). */
  meanings: Map<string, Word[]>;
}

/** Utterances are joined one per line, so the reader breaks between speakers'
 *  turns instead of running them together. */
const JOINER = "\n";

/**
 * Present append-only per-utterance analyses as one document the reader can render.
 * PURE.
 */
export function mergeTranscript(blocks: readonly TranscriptBlock[]): MergedTranscript {
  const tokens: AnalyzedToken[] = [];
  const meanings = new Map<string, Word[]>();
  let text = "";

  for (const block of blocks) {
    const base = text.length;
    text += (base === 0 ? "" : JOINER) + block.text;
    // Rebase: `base` plus the joiner that was just written before this block.
    const offset = base === 0 ? 0 : base + JOINER.length;
    for (const token of block.tokens) {
      tokens.push({ ...token, start: token.start + offset, end: token.end + offset });
    }
    for (const [surface, senses] of block.meanings) {
      // First writer wins: the same surface resolves to the same senses either way,
      // and keeping the earliest keeps the map stable as the transcript grows.
      if (!meanings.has(surface)) meanings.set(surface, senses);
    }
  }

  return { text, tokens, meanings };
}
