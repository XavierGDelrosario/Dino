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
  /** Coarse part-of-speech (kuromoji's, e.g. 名詞/動詞/助詞), or null. */
  pos: string | null;
}

// kuromoji POS tags for INDEPENDENT content words (vs particles 助詞, auxiliaries
// 助動詞, symbols 記号). Used to tell a single word from a phrase/sentence, and to
// skip grammatical tokens (に, た) in the reader — they aren't vocabulary.
const CONTENT_POS = new Set([
  "名詞", "動詞", "形容詞", "副詞", "連体詞", "感動詞", "接頭詞",
]);

/**
 * Is this a content word worth treating as vocabulary? JA: a content POS (not a
 * particle/auxiliary/symbol). Non-JA tokens carry no POS (`null`) → treated as
 * content so English words still count.
 */
export function isContentPos(pos: string | null): boolean {
  return pos === null || CONTENT_POS.has(pos);
}

/**
 * True if `text` is a SINGLE word (one content word), not a phrase/sentence — so
 * the UI can route to single-word lookup vs the paragraph reader without a manual
 * toggle. JA: one content token and no particle (so 行った = 行っ+た is one verb,
 * but 日本に行った is not). Other languages: one segmented token.
 */
export function isSingleWord(tokens: AnalyzedToken[], lang: LangCode): boolean {
  if (tokens.length === 0) return false;
  if (lang.toUpperCase() === "JA") {
    const content = tokens.filter((t) => t.pos !== null && CONTENT_POS.has(t.pos));
    const hasParticle = tokens.some((t) => t.pos === "助詞");
    return content.length <= 1 && !hasParticle;
  }
  return tokens.length === 1;
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
    pos: null,
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
    let pos = t.pos && t.pos !== UNKNOWN ? t.pos : null;
    // DEPENDENT verbs (kuromoji 動詞 非自立 / 接尾) are grammatical, not vocabulary:
    // the いる in ～ている, くる in ～てくる, みる in ～てみる, etc. Without this they'd
    // be treated as the standalone verbs 居る/来る/見る. Relabel them as auxiliaries
    // (助動詞) so the reader renders them as plain text and they don't count as a
    // separate content word (so 食べている stays one word — 食べる — not 食べ + いる).
    // Standalone いる ("to exist") is 動詞 自立 and is unaffected.
    if (pos === "動詞" && (t.pos_detail_1 === "非自立" || t.pos_detail_1 === "接尾")) {
      pos = "助動詞";
    }
    out.push({
      text: t.surface_form,
      start,
      end: start + t.surface_form.length,
      reading,
      lemma,
      pos,
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
