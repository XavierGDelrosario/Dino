// =========================================================
// Morphological analysis seam.
//
// `analyze` is the single interface the rest of the app depends on for word
// segmentation + (where available) readings and lemmas. Japanese is handled by
// kuromoji, loaded LAZILY (dynamic import) so its ~12MB dictionary engine stays
// out of the main bundle until Japanese is actually analyzed; every other
// language falls back to plain Intl.Segmenter segmentation with no reading/lemma.
//
// This `analyze()` interface IS the swap boundary: changing the Japanese engine
// (a different analyzer, furigana alignment, or relocating it server-side) only
// touches the JA branch below — callers never move. It lives inline because today
// it's a few lines; lift it into its own module only if that swap grows into a
// whole subsystem.
//
// kuromoji's dictionary is static data — NOT bundled, NOT database storage:
//   * Node / tests: read from the installed package (node_modules/kuromoji/dict).
//   * Browser: SERVE the dict — copy node_modules/kuromoji/dict → public/dict so
//     the default "/dict/" path resolves (e.g. via vite-plugin-static-copy).
//
// CAVEAT: kuromoji is a statistical model (IPADIC). It greatly improves
// segmentation and gives lemmas, but readings of short/ambiguous fragments can
// still be wrong (e.g. 行った in isolation → 行う, 今 → こん). Good, not infallible.
// =========================================================

import type { IpadicFeatures, Tokenizer } from "kuromoji";
import type { LangCode } from "./registry";
import { tokenizeWords, type WordToken } from "./tokenize";

/** A segmented word, enriched with reading/lemma when the language supports it. */
export interface AnalyzedToken extends WordToken {
  /** Pronunciation reading in hiragana, or null when unknown / not applicable. */
  reading: string | null;
  /** Dictionary (base) form, or null when unknown / not applicable. */
  lemma: string | null;
}

/** Languages that get morphological analysis (reading + lemma) vs. plain segmentation. */
function needsMorphology(lang: LangCode): boolean {
  return lang.toUpperCase() === "JA";
}

/** Plain segmentation with no enrichment — the non-JA path and the JA fallback. */
function segmentOnly(text: string, lang: LangCode): AnalyzedToken[] {
  return tokenizeWords(text, lang).map((t: WordToken) => ({
    ...t,
    reading: null,
    lemma: null,
  }));
}

// --- Japanese: kuromoji (lazily loaded) ------------------------------------

const UNKNOWN = "*"; // kuromoji's placeholder for "no value" on a feature

function jaDicPath(): string {
  // Browser: served static assets under /dict/. Node (tests/SSR): the package.
  return typeof window === "undefined" ? "node_modules/kuromoji/dict" : "/dict/";
}

// kuromoji returns readings in katakana; furigana wants hiragana.
function katakanaToHiragana(s: string): string {
  return s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

// Build the tokenizer once (loads + parses the dictionary, ~hundreds of ms) and
// reuse the promise. The dynamic import is what keeps kuromoji in its own lazy
// chunk. On failure we clear the cache so a later call can retry.
let tokenizerPromise: Promise<Tokenizer<IpadicFeatures>> | null = null;
function getJaTokenizer(): Promise<Tokenizer<IpadicFeatures>> {
  if (!tokenizerPromise) {
    tokenizerPromise = import("kuromoji")
      .then(
        ({ builder }) =>
          new Promise<Tokenizer<IpadicFeatures>>((resolve, reject) => {
            builder({ dicPath: jaDicPath() }).build((err, tokenizer) => {
              if (err) reject(err);
              else resolve(tokenizer);
            });
          })
      )
      .catch((err) => {
        tokenizerPromise = null; // allow a retry on a later call
        throw err;
      });
  }
  return tokenizerPromise;
}

async function analyzeJapanese(text: string): Promise<AnalyzedToken[]> {
  const tokenizer = await getJaTokenizer();
  const out: AnalyzedToken[] = [];
  for (const t of tokenizer.tokenize(text)) {
    if (t.pos === "記号" || t.surface_form.trim() === "") continue; // punctuation/space
    const start = t.word_position - 1;
    const reading =
      t.reading && t.reading !== UNKNOWN ? katakanaToHiragana(t.reading) : null;
    const lemma = t.basic_form && t.basic_form !== UNKNOWN ? t.basic_form : null;
    out.push({
      text: t.surface_form,
      start,
      end: start + t.surface_form.length,
      reading,
      lemma,
    });
  }
  return out;
}

// --- Public seam ------------------------------------------------------------

/**
 * Segment `text` into words, enriched with reading + lemma where the language
 * supports it (currently Japanese, via kuromoji). Async because the Japanese
 * analyzer loads a dictionary on first use.
 *
 * OUTPUT: AnalyzedToken[] in reading order, each with offsets into `text`.
 * CONSTRAINTS: if the Japanese analyzer can't load (unsupported runtime / missing
 * dictionary), it degrades to segmentation-only (reading/lemma null) rather than
 * throwing — readings are a progressive enhancement, never a hard dependency.
 */
export async function analyze(text: string, lang: LangCode): Promise<AnalyzedToken[]> {
  if (needsMorphology(lang)) {
    try {
      return await analyzeJapanese(text);
    } catch (err) {
      console.warn(
        "[analyze] Japanese morphological analysis unavailable; " +
          "falling back to segmentation without readings.",
        err
      );
    }
  }
  return segmentOnly(text, lang);
}
