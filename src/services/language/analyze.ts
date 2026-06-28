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
import { getCounterResolver, parseJapaneseNumber } from "./counters";

/** A segmented word, enriched with reading/lemma when the language supports it. */
export interface AnalyzedToken extends WordToken {
  /** Pronunciation reading in hiragana, or null when unknown / not applicable. */
  reading: string | null;
  /** Dictionary (base) form, or null when unknown / not applicable. */
  lemma: string | null;
  /** Coarse part-of-speech (kuromoji's, e.g. 名詞/動詞/助詞), or null. */
  pos: string | null;
  /** True for a number+counter token merged into one (三本 → さんぼん, lemma 本). The
   *  `reading` is whole-span group ruby and `lemma` points at the counter for lookup. */
  composite?: boolean;
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
    // A lone number+counter (三本) is a composite, not a single dictionary word — route
    // it to the reader so it shows as さんぼん pointing at the counter, not a failed lookup.
    const hasComposite = tokens.some((t) => t.composite);
    return content.length <= 1 && !hasParticle && !hasComposite;
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

// A SYNTHETIC pos (not a kuromoji tag) for embedded non-Japanese tokens — Latin
// acronyms (QR, URL), bare Arabic numerals (3) — that kuromoji tags as 名詞-固有名詞 /
// 名詞-数. They aren't Japanese vocabulary, so we mark them non-content (isContentPos
// → false) to render as plain, non-lookup text — but KEEP them visible (unlike
// dropped punctuation). Katakana loanwords (コード) contain Japanese script and are
// unaffected; this only catches tokens with NO kana/kanji.
const FOREIGN_POS = "外国語";
const HAS_JAPANESE = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;

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

/**
 * Kick off the kuromoji dictionary load WITHOUT analyzing anything, so the first
 * real Japanese analysis doesn't pay the ~12MB load latency. Safe to call eagerly
 * (e.g. on app idle): it shares the same cached promise as analyze(), is a no-op
 * once warm, and swallows load errors (analyze() retries + degrades on its own).
 */
export function warmJapaneseAnalyzer(): void {
  getJaTokenizer().catch(() => {
    /* a real analyze() call will retry + fall back to segmentation */
  });
}

async function analyzeJapanese(text: string): Promise<AnalyzedToken[]> {
  const tokenizer = await getJaTokenizer();
  const out: AnalyzedToken[] = [];
  // Kept raw tokens, PARALLEL to `out` (both push only for non-dropped tokens), so the
  // counter post-pass can read kuromoji's pos_detail (not carried on AnalyzedToken).
  const kept: IpadicFeatures[] = [];
  for (const t of tokenizer.tokenize(text)) {
    // Drop punctuation, symbols, and whitespace — anything with NO letter/digit.
    // Stricter than the POS check alone: kuromoji tags ASCII quotes/punctuation it
    // doesn't recognize as 名詞 (unknown noun), which would otherwise render as a
    // highlightable, addable "word" (e.g. a lone " shown blue in the reader).
    if (t.pos === "記号" || !/[\p{L}\p{N}]/u.test(t.surface_form)) continue;
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
    // Embedded non-Japanese tokens (QR, URL, bare digits) → plain text, not vocabulary.
    if (pos !== null && !HAS_JAPANESE.test(t.surface_form)) {
      pos = FOREIGN_POS;
    }
    out.push({
      text: t.surface_form,
      start,
      end: start + t.surface_form.length,
      reading,
      lemma,
      pos,
    });
    kept.push(t);
  }
  applyCounterReadings(out, kept);
  return mergeCounterTokens(out, kept);
}

// Merge a kanji number run + its counter into ONE composite token (三本 → text 三本,
// reading さんぼん as whole-span group ruby, lemma 本 so the lookup resolves to the
// counter's sense). Runs AFTER applyCounterReadings, so it just concatenates the already-
// corrected per-token readings — which is what finally places multi-token jukujikun ruby
// correctly (二十歳 → はたち over 二十歳, not scattered). Only ALL-KANJI runs merge: a bare
// digit (3本) has no number reading, so it stays separate with the counter's fixed reading.
function mergeCounterTokens(out: AnalyzedToken[], kept: IpadicFeatures[]): AnalyzedToken[] {
  const numbersByCounter = new Map<number, number[]>(); // counter index → number-token indices
  for (let i = 0; i < kept.length; i++) {
    const c = kept[i];
    if (!(c.pos === "名詞" && c.pos_detail_1 === "接尾" && c.pos_detail_2 === "助数詞")) continue;
    const numIdx: number[] = [];
    for (let j = i - 1; j >= 0 && kept[j].pos === "名詞" && kept[j].pos_detail_1 === "数"; j--) {
      numIdx.unshift(j);
    }
    if (numIdx.length > 0 && numIdx.every((k) => HAS_JAPANESE.test(kept[k].surface_form))) {
      numbersByCounter.set(i, numIdx);
    }
  }
  if (numbersByCounter.size === 0) return out;

  const absorbed = new Set<number>();
  for (const nums of numbersByCounter.values()) for (const k of nums) absorbed.add(k);
  const result: AnalyzedToken[] = [];
  for (let i = 0; i < out.length; i++) {
    if (absorbed.has(i)) continue; // folded into the counter token below
    const nums = numbersByCounter.get(i);
    if (!nums) {
      result.push(out[i]);
      continue;
    }
    const span = [...nums, i];
    result.push({
      text: span.map((k) => out[k].text).join(""),
      start: out[nums[0]].start,
      end: out[i].end,
      reading: span.map((k) => out[k].reading ?? "").join("") || null,
      lemma: kept[i].surface_form, // the counter — meaning lookup resolves to it
      pos: out[i].pos,
      composite: true,
    });
  }
  return result;
}

// Fix 助数詞 (counter) furigana: kuromoji gives a counter its CITATION reading (三本 →
// ホン), never the euphonic form (さんぼん). Detect a run of number tokens (名詞-数)
// immediately followed by a counter (名詞-接尾-助数詞) and rewrite both readings via the
// per-language counter resolver. The standalone noun 本 (名詞-一般) is NOT a counter, so
// it's untouched. A pure overwrite on `out`: an unknown counter / unparseable number /
// no resolver leaves the engine's reading as-is (graceful degradation).
function applyCounterReadings(out: AnalyzedToken[], kept: IpadicFeatures[]): void {
  const resolver = getCounterResolver("JA");
  if (!resolver) return;
  for (let i = 0; i < kept.length; i++) {
    const c = kept[i];
    if (!(c.pos === "名詞" && c.pos_detail_1 === "接尾" && c.pos_detail_2 === "助数詞")) {
      continue;
    }
    const numIdx: number[] = [];
    for (let j = i - 1; j >= 0 && kept[j].pos === "名詞" && kept[j].pos_detail_1 === "数"; j--) {
      numIdx.unshift(j);
    }
    if (numIdx.length === 0) continue;
    const value = parseJapaneseNumber(numIdx.map((k) => kept[k].surface_form));
    if (value === null) continue;
    const r = resolver.resolve(value, c.surface_form);
    if (!r) continue;
    out[i].reading = r.counterReading;
    // Number readings only annotate KANJI tokens — a bare digit (3本) needs no furigana;
    // the counter reading (ぼん) is corrected regardless.
    if (r.numberReading !== null) {
      if (r.replacesRun) {
        // Jukujikun spanning the whole number (二十歳 → はたち): full reading on the
        // FIRST kanji token, blank the rest, so the joined reading is correct.
        let placed = false;
        for (const k of numIdx) {
          if (!HAS_JAPANESE.test(kept[k].surface_form)) continue;
          out[k].reading = placed ? "" : r.numberReading;
          placed = true;
        }
      } else {
        const last = numIdx[numIdx.length - 1];
        if (HAS_JAPANESE.test(kept[last].surface_form)) out[last].reading = r.numberReading;
      }
    }
  }
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
