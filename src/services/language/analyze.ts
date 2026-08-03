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
import { mergeJapaneseCompounds } from "./compounds";
import { functionWordPos } from "./functionWords";

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
 * particle/auxiliary/symbol). English closed-class words carry the synthetic
 * FUNCTION_WORD_POS and are excluded the same way (see language/functionWords).
 *
 * `null` still means CONTENT — that failure mode is load-bearing: a language with no
 * analyser at all must still show its words rather than none. So a new language is
 * over-inclusive (every token is vocabulary) until it earns a POS source or a
 * closed-class list, never silently empty.
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

/**
 * The DICTIONARY-FORM lookup key for an already-analyzed single word: the LEMMA of
 * its content token (行った → 行く), since the dictionary is keyed on dictionary
 * forms and an inflected surface matches nothing. Falls back to the surface text.
 *
 * The same rule the paragraph reader applies per token (lookup.ts `keyOf`), factored
 * out so every single-word surface (Translate, the Lists add form) resolves inflections
 * identically instead of each re-deriving it.
 *
 * NOTE: only kuromoji (JA) produces lemmas — for a language analyzed by
 * `Intl.Segmenter` every token's lemma is null, so an English "ran"/"running" comes
 * back UNCHANGED. English inflection is not handled anywhere in the app today.
 *
 * OUTPUT: the lemma, or `fallback`. PURE.
 */
export function dictionaryFormOf(tokens: AnalyzedToken[], fallback: string): string {
  const content = tokens.find((t) => t.pos !== null && isContentPos(t.pos));
  return content?.lemma ?? content?.text ?? fallback;
}

/**
 * `dictionaryFormOf` for raw text: analyze, then take the lemma when the text is a
 * SINGLE word (a phrase is returned unchanged — it belongs in the paragraph reader,
 * which lemmatizes per token itself).
 *
 * OUTPUT: the dictionary form to look up. Analyzes, so it may lazily load kuromoji.
 */
export async function dictionaryForm(text: string, lang: LangCode): Promise<string> {
  const tokens = await analyze(text, lang);
  if (!isSingleWord(tokens, lang)) return text;
  return dictionaryFormOf(tokens, text);
}

/** Languages that get morphological analysis (reading + lemma) vs. plain segmentation. */
function needsMorphology(lang: LangCode): boolean {
  return lang.toUpperCase() === "JA";
}

/** Plain segmentation with no enrichment — the non-JA path and the JA fallback.
 *  The one enrichment it DOES do is the closed-class tag: without a POS tagger it's
 *  the only thing standing between an English paste and a vocabulary list full of
 *  "the" and "was". Languages with no list keep `pos: null` (content by default). */
function segmentOnly(text: string, lang: LangCode): AnalyzedToken[] {
  return tokenizeWords(text, lang).map((t: WordToken) => ({
    ...t,
    reading: null,
    lemma: null,
    pos: functionWordPos(t.text, lang),
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

// SYNTHETIC poses for PROPER NAMES — people (kuromoji 名詞-固有名詞-人名: 佐野, 田中,
// 太郎) and organizations (名詞-固有名詞-組織: トヨタ自動車, ソニー, 任天堂, 国連, 自民党,
// 朝日新聞). A name is not vocabulary — nobody studies 佐野 or 朝日新聞 — so a news
// article shouldn't fill the reader with addable blue words or pad the article word
// list with the actors in one story. Like FOREIGN_POS they stay VISIBLE as plain
// text; only their vocabulary-ness is dropped. Typing a name into Translate still
// looks it up (isSingleWord counts content tokens, and zero passes its `<= 1` test),
// which is the right split: explicit lookup is a question the user asked, a name
// inside a paste is not.
//
// 組織 was previously left alone on the belief that it doubled as IPADIC's
// unknown-KATAKANA bucket (so demoting it would hide loanwords). MEASURED against
// the bundled IPADIC and that is not so: unknown/modern katakana lands in 名詞-一般
// (スマホ・サブスク・コロナ・メタバース・リスキリング・エヌビディア・テスラ all verified),
// while 組織 holds actual organizations. Only mis-segmented fragments leak in (タイパ
// → タイ+パ), which are junk with no dictionary entry either way.
//
// The other 固有名詞 subcategories keep their content POS:
//   * 地域 (東京, 日本, アメリカ, 中国) — real vocabulary a learner wants.
//   * 一般 (富士山) — likewise, plus IPADIC's catch-all for unknown kanji words.
// Multi-token org names are only partly caught: 日本放送協会 segments as
// 日本(地域)+放送+協会, so its pieces stay addable as the ordinary words they are.
const PERSON_NAME_POS = "人名";
const ORGANIZATION_POS = "組織";

// …with ONE exemption inside 組織: public institutions. Measured over 120 random
// Wikinews articles, the 組織 demotion drops 1.8% of content tokens and ~18% of those
// are civics vocabulary a news reader genuinely needs — 労働省, 気象庁, 衆議院, 警視庁,
// 警察庁, 消防庁, 海上保安庁, 最高裁, 農林水産省 — not brands. They read as compounds
// (気象 + 庁), so a learner can decode and reuse them, unlike 読売新聞 or 吉野家.
//
// Matched by SUFFIX because that is what generalizes: every ministry ends 省, every
// agency 庁, the legislature 議院/院, the courts 裁, bureaus 局, boards 委員会. 学院 is
// excluded — it is the tail of university names (明治学院), which are proper names.
// Party names (自民党) and 東証 stay demoted: those are named entities, not compounds.
// JMdict's editorial `common` flag would separate the two groups more exactly (気象庁
// true / 読売新聞 false, where corpus frequency does not discriminate at all), but it
// isn't carried on `words` — a column + projection bump, deferred as not worth it.
const INSTITUTION_SUFFIX = /(庁|省|局|院|裁|委員会)$/;
const INSTITUTION_EXCEPT = /学院$/;
const FIXED_INSTITUTIONS = new Set(["国連", "赤十字"]);

/** True for a 組織-tagged token that is a public institution, not a brand/named entity. */
function isInstitution(surface: string): boolean {
  if (FIXED_INSTITUTIONS.has(surface)) return true;
  return INSTITUTION_SUFFIX.test(surface) && !INSTITUTION_EXCEPT.test(surface);
}

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
        (mod) =>
          new Promise<Tokenizer<IpadicFeatures>>((resolve, reject) => {
            // kuromoji is CommonJS. Vite and Vitest interop it so `builder` sits on the
            // namespace, but a plain Node ESM loader (tsx — how scripts/ run) puts it on
            // `.default`, and destructuring `{ builder }` there yields undefined. That
            // threw "builder is not a function", which analyzeJapanese CATCHES and turns
            // into a silent Intl.Segmenter fallback — so a Node caller got segmentation
            // with no readings or lemmas and no error. Accept both shapes.
            const builder = mod.builder ?? (mod as unknown as { default?: typeof mod }).default?.builder;
            if (typeof builder !== "function") {
              reject(new Error("kuromoji: no builder export found on the module"));
              return;
            }
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
    // Proper names — people (佐野, 山田太郎) and organizations (ソニー, 国連) → plain
    // text, not vocabulary. See PERSON_NAME_POS / ORGANIZATION_POS.
    if (pos === "名詞" && t.pos_detail_1 === "固有名詞") {
      if (t.pos_detail_2 === "人名") pos = PERSON_NAME_POS;
      else if (t.pos_detail_2 === "組織" && !isInstitution(t.surface_form)) {
        pos = ORGANIZATION_POS;
      }
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
  // Re-merge whole words IPADIC over-segmented (大規模 → 大＋規模) BEFORE the reader
  // looks tokens up — a curated compound-aware pass (kuromoji.js has no user dict).
  return mergeJapaneseCompounds(mergeCounterTokens(out, kept));
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
