// Morphological analysis seam.
//
// `analyze` is the single interface the app depends on for word segmentation +
// (where available) readings and lemmas. Japanese goes to kuromoji, loaded LAZILY so
// its ~12MB dictionary stays out of the main bundle; every other language falls back
// to plain Intl.Segmenter segmentation with no reading/lemma.
//
// This interface IS the swap boundary: changing the Japanese engine, or moving it
// server-side, only touches the JA branch below — callers never move.
//
// kuromoji's dictionary is static data, neither bundled nor in the database: Node and
// tests read it from node_modules/kuromoji/dict; the browser needs it COPIED to
// public/dict so the default "/dict/" path resolves.
//
// CAVEAT: IPADIC is a statistical model. Segmentation and lemmas are good, but the
// reading of a short/ambiguous fragment can be wrong (行った alone → 行う, 今 → こん).

import type { IpadicFeatures, Tokenizer } from "kuromoji";
import type { LangCode } from "./registry";
import { tokenizeWords, type WordToken } from "./tokenize";
import { getCounterResolver, parseJapaneseNumber } from "./counters";
import { mergeJapaneseCompounds } from "./compounds";
import { functionWordPos } from "./functionWords";
import { readerLemma } from "./lemmaEn";
import { tagEnglish } from "./posEn";

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
  // UD UPOS tags, carried on ENGLISH tokens since the tagger landed (posEn.ts). The
  // two vocabularies cannot collide — one is Japanese text, the other ASCII — so they
  // share this set rather than forking isContentPos by language.
  //
  // ‼️ PROPN IS DELIBERATELY IN HERE. It is tempting to treat "this is a name" as "this
  // is not vocabulary", and an early cut did exactly that; measured on the UD test
  // split it removed 2.93% of genuine content words, and the ones it removed were
  // PERFORMANCE · Parts · Telephone · Camera · Internet — capitalised common nouns from
  // headings, i.e. words the DICTIONARY KNOWS. The real names it also caught (UEFA,
  // Abidal, Piraquara) are precisely the ones the dictionary does NOT know.
  //
  // So the dictionary is the arbiter of what is vocabulary, and the tagger's PROPN is
  // used for the one decision the dictionary cannot make for itself: whether to SPEND
  // MONEY translating a miss. A name still gets looked up, still misses, and still
  // greys out — it just never reaches the paid MT fallback. See properNounSurfaces()
  // below and the edge's skipMt handling.
  // Everything absent is grammar, punctuation or noise and is excluded by omission:
  // DET · ADP · PRON · AUX · CCONJ · SCONJ · PART · PUNCT · SYM · X. That list is what
  // now replaces the surface-matched English function-word gamble with real tags —
  // `functionWords.ts` had to exclude can/may/will BY NAME because it could not see
  // context, and the tagger simply reads them.
  "NOUN", "VERB", "ADJ", "ADV", "INTJ", "NUM", "PROPN",
]);

/**
 * Is this a content word worth treating as vocabulary? English closed-class words carry
 * the synthetic FUNCTION_WORD_POS and are excluded the same way.
 *
 * `null` still means CONTENT, and that failure mode is load-bearing: a language with no
 * analyser must show its words rather than none, so a new language is over-inclusive
 * until it earns a POS source — never silently empty.
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
    // A lone number+counter (三本) is a composite, not a dictionary word — route it to
    // the reader so it shows さんぼん pointing at the counter, not a failed lookup.
    const hasComposite = tokens.some((t) => t.composite);
    return content.length <= 1 && !hasParticle && !hasComposite;
  }
  return tokens.length === 1;
}

/**
 * The DICTIONARY-FORM lookup key for an already-analyzed single word: the LEMMA of its
 * content token (行った → 行く), since the dictionary is keyed on dictionary forms.
 * Falls back to the surface. Same rule the reader applies per token (lookup.ts `keyOf`),
 * factored out so every single-word surface resolves inflections identically.
 */
export function dictionaryFormOf(tokens: AnalyzedToken[], fallback: string): string {
  const content = tokens.find((t) => t.pos !== null && isContentPos(t.pos));
  return content?.lemma ?? content?.text ?? fallback;
}

/**
 * `dictionaryFormOf` for raw text. A phrase is returned unchanged — it belongs in the
 * paragraph reader, which lemmatizes per token itself. May lazily load kuromoji.
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

// SYNTHETIC pos for tokens that are not vocabulary in ANY language — the non-JA
// counterpart of FOREIGN_POS below, which already keeps bare Latin and digits out of
// the Japanese reader. Without it, `segmentOnly`'s only filter is the closed-class
// list, so anything not spelled like a grammar word counts as a word to learn:
// observed live, a stray "G" was offered as vocabulary, and letter-spaced text
// ("G o o g l e", which is what OCR returns for a wordmark) became SIX addable words.
// Like the other synthetic poses the token stays VISIBLE as plain text; only its
// vocabulary-ness is dropped.
const NON_WORD_POS = "non-word";

/**
 * The synthetic POS for a token that can't be vocabulary, or null to leave it alone.
 *
 * Two rules, both script-aware so this stays safe for languages we can't analyse:
 *   · NO LETTER AT ALL — "2026", "0120", "%". The same test `shouldSkipMt` uses
 *     server-side before paying for a translation (a page number is not a word).
 *   · A SINGLE LATIN LETTER — "G", "x". Deliberately Latin-only: a lone Han character
 *     IS a word (日, 山) and so is a lone kana, so this must never widen to \p{L}.
 *     The only single-letter English words, "a" and "I", are already function words.
 *
 * This does NOT demote a full proper noun like "Google" — telling that from a
 * sentence-initial content word ("Cats") needs a real tagger (docs/TODO.md).
 */
function nonVocabularyPos(text: string): string | null {
  const s = text.normalize("NFC").trim();
  if (!/\p{L}/u.test(s)) return NON_WORD_POS;
  if (/^\p{Script=Latin}$/u.test(s)) return NON_WORD_POS;
  return null;
}

/** Plain segmentation — the non-JA path and the JA fallback. Its enrichments are the
 *  junk filter and the closed-class tag: without a POS tagger that's all that stands
 *  between an English paste and a vocabulary list full of "the", "was" and "G". */
function segmentOnly(text: string, lang: LangCode): AnalyzedToken[] {
  return tokenizeWords(text, lang).map((t: WordToken) => ({
    ...t,
    reading: null,
    // The reader looks up by `lemma ?? text`, so this collapses cat/cats onto one
    // entry and stops a homograph surface (sat → SAT the assault team) beating the
    // verb. Null where no rule is safe, restoring look-up-as-written.
    lemma: readerLemma(t.text, lang),
    // Junk first: it is language-independent, so it applies even where no
    // closed-class list exists.
    pos: nonVocabularyPos(t.text) ?? functionWordPos(t.text, lang),
  }));
}

// --- Japanese: kuromoji (lazily loaded) ------------------------------------

const UNKNOWN = "*"; // kuromoji's placeholder for "no value" on a feature

// SYNTHETIC pos (not a kuromoji tag) for embedded non-Japanese tokens — Latin acronyms
// (QR, URL), bare digits — which kuromoji tags as nouns. Not Japanese vocabulary, so
// they render as plain non-lookup text but stay VISIBLE (unlike dropped punctuation).
// Only catches tokens with NO kana/kanji, so katakana loanwords are unaffected.
const FOREIGN_POS = "外国語";
const HAS_JAPANESE = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;

// SYNTHETIC poses for PROPER NAMES — people (名詞-固有名詞-人名) and organizations
// (…-組織: ソニー, 自民党, 朝日新聞). Nobody studies 佐野 or 朝日新聞, so a news article
// shouldn't fill the reader with addable words naming the actors in one story. Like
// FOREIGN_POS they stay VISIBLE as plain text; only their vocabulary-ness is dropped.
// Typing a name into Translate still looks it up (isSingleWord counts content tokens,
// and zero passes its `<= 1` test) — explicit lookup is a question the user asked.
//
// Demoting 組織 is safe: unknown/modern katakana lands in 名詞-一般 (verified for
// スマホ・サブスク・コロナ・テスラ), not 組織, so loanwords aren't hidden. The other
// 固有名詞 subcategories keep their content POS — 地域 (東京, アメリカ) and 一般 (富士山,
// plus IPADIC's catch-all for unknown kanji words) are real vocabulary.
const PERSON_NAME_POS = "人名";
const ORGANIZATION_POS = "組織";

// …with ONE exemption inside 組織: public institutions. The demotion drops 1.8% of
// content tokens and ~18% of those are civics vocabulary a news reader needs — 気象庁,
// 衆議院, 警視庁, 最高裁 — which read as compounds (気象 + 庁) a learner can decode and
// reuse, unlike 読売新聞. Matched by SUFFIX because that generalizes: every ministry
// ends 省, every agency 庁, the courts 裁, boards 委員会. 学院 is excluded (it tails
// university names); party names stay demoted, being entities rather than compounds.
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

// Build the tokenizer once (loading + parsing the dictionary takes ~hundreds of ms) and
// reuse the promise; the dynamic import keeps kuromoji in its own lazy chunk. On failure
// the cache is cleared so a later call can retry.
let tokenizerPromise: Promise<Tokenizer<IpadicFeatures>> | null = null;
function getJaTokenizer(): Promise<Tokenizer<IpadicFeatures>> {
  if (!tokenizerPromise) {
    tokenizerPromise = import("kuromoji")
      .then(
        (mod) =>
          new Promise<Tokenizer<IpadicFeatures>>((resolve, reject) => {
            // kuromoji is CommonJS: Vite and Vitest interop it so `builder` sits on the
            // namespace, but a plain Node ESM loader (tsx, how scripts/ run) puts it on
            // `.default`. Destructuring the wrong one threw, analyzeJapanese CAUGHT it,
            // and a Node caller silently got segmentation with no readings or lemmas.
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
 * Kick off the kuromoji dictionary load WITHOUT analyzing, so the first real analysis
 * doesn't pay the ~12MB latency. Safe to call eagerly: shares analyze()'s cached
 * promise, is a no-op once warm, and swallows errors (analyze() retries and degrades).
 */
export function warmJapaneseAnalyzer(): void {
  getJaTokenizer().catch(() => {
    /* a real analyze() call will retry + fall back to segmentation */
  });
}

async function analyzeJapanese(text: string): Promise<AnalyzedToken[]> {
  const tokenizer = await getJaTokenizer();
  const out: AnalyzedToken[] = [];
  // Raw tokens kept PARALLEL to `out` (both push only for non-dropped tokens), so the
  // counter post-pass can read kuromoji's pos_detail, which AnalyzedToken doesn't carry.
  const kept: IpadicFeatures[] = [];
  for (const t of tokenizer.tokenize(text)) {
    // Drop anything with NO letter/digit. Stricter than the POS check alone, because
    // kuromoji tags unrecognized ASCII punctuation as 名詞 — a lone " would otherwise
    // render as an addable word.
    if (t.pos === "記号" || !/[\p{L}\p{N}]/u.test(t.surface_form)) continue;
    const start = t.word_position - 1;
    const reading =
      t.reading && t.reading !== UNKNOWN ? katakanaToHiragana(t.reading) : null;
    const lemma = t.basic_form && t.basic_form !== UNKNOWN ? t.basic_form : null;
    let pos = t.pos && t.pos !== UNKNOWN ? t.pos : null;
    // DEPENDENT verbs (動詞 非自立/接尾) are grammar, not vocabulary — the いる in
    // ～ている, くる in ～てくる. Relabelled as auxiliaries so the reader renders them as
    // plain text and 食べている counts as one word (食べる), not 食べ + いる. Standalone
    // いる ("to exist") is 動詞 自立 and is unaffected.
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
  // Re-merge whole words IPADIC over-segmented (大規模 → 大＋規模) BEFORE lookup — a
  // curated compound pass, since kuromoji.js has no user dictionary.
  return mergeJapaneseCompounds(mergeCounterTokens(out, kept));
}

// Merge a kanji number run + its counter into ONE composite token (三本 → reading さんぼん
// as whole-span group ruby, lemma 本 so lookup resolves to the counter's sense). Runs
// AFTER applyCounterReadings, so it concatenates already-corrected readings — which is
// what places multi-token jukujikun ruby correctly (二十歳 → はたち, not scattered). Only
// ALL-KANJI runs merge: a bare digit (3本) has no number reading.
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
// ホン), never the euphonic さんぼん. Rewrites both readings via the per-language counter
// resolver when a number run is immediately followed by a counter. The standalone noun
// 本 is NOT a counter and is untouched; an unknown counter or unparseable number leaves
// the engine's reading as-is.
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
    // Number readings only annotate KANJI tokens — a bare digit needs no furigana. The
    // counter reading is corrected regardless.
    if (r.numberReading !== null) {
      if (r.replacesRun) {
        // Jukujikun spanning the whole number (二十歳 → はたち): the full reading goes on
        // the FIRST kanji token, the rest blank, so the joined reading is correct.
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

// --- English: averaged-perceptron POS (lazily loaded) ------------------------

/** Languages with a real POS tagger of their own. English only, for now — every other
 *  Latin-script language still falls through to `segmentOnly`'s closed-class list. */
function hasEnglishPos(lang: LangCode): boolean {
  return lang.toUpperCase() === "EN";
}

/**
 * Group token indices into sentences.
 *
 * This matters more than it looks. The tagger's strongest orthographic cue is
 * "capitalised AND not sentence-initial", so if the whole paragraph were handed over as
 * one sequence, only its very first token would ever be sentence-initial and every
 * other sentence's opening word would read as a name. We have no punctuation tokens
 * (the segmenter yields word-like tokens only), so boundaries are recovered from the
 * SOURCE TEXT in the gap between one token's end and the next one's start.
 */
function sentenceGroups(text: string, tokens: WordToken[]): number[][] {
  const groups: number[][] = [];
  let cur: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (i > 0) {
      const gap = text.slice(tokens[i - 1].end, tokens[i].start);
      // Ellipses and the CJK full stop are included: a paste can mix scripts, and a
      // boundary we miss costs one wrongly-capitalised token, never a crash.
      if (/[.!?。！？…]/.test(gap)) {
        if (cur.length) groups.push(cur);
        cur = [];
      }
    }
    cur.push(i);
  }
  if (cur.length) groups.push(cur);
  return groups;
}

/**
 * English analysis: segment, then tag each sentence with the perceptron model.
 *
 * The junk filter still runs FIRST and still wins — it is language-independent and
 * catches things ("2026", a lone "G") that a POS tagger would happily label NOUN. Only
 * where it has no opinion does the model's tag stand.
 */
async function analyzeEnglish(text: string, lang: LangCode): Promise<AnalyzedToken[]> {
  const tokens = tokenizeWords(text, lang);
  if (tokens.length === 0) return [];

  const tags = new Array<string | null>(tokens.length).fill(null);
  for (const group of sentenceGroups(text, tokens)) {
    const tagged = await tagEnglish(group.map((i) => tokens[i].text));
    if (!tagged) return segmentOnly(text, lang); // model unavailable — degrade, don't throw
    group.forEach((tokenIndex, k) => {
      tags[tokenIndex] = tagged[k];
    });
  }

  return tokens.map((t, i) => ({
    ...t,
    reading: null,
    lemma: readerLemma(t.text, lang),
    pos: nonVocabularyPos(t.text) ?? tags[i],
  }));
}

// --- Public seam ------------------------------------------------------------

/**
 * Segment `text` into words in reading order, each with offsets into `text` and, where
 * the language supports it, a reading + lemma. Async because the Japanese analyzer
 * loads a dictionary on first use. If that load fails it degrades to segmentation-only
 * rather than throwing — readings are a progressive enhancement, not a dependency.
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
  if (hasEnglishPos(lang)) {
    try {
      return await analyzeEnglish(text, lang);
    } catch (err) {
      // Same contract as the Japanese branch: a POS source is an enhancement, and
      // losing it must cost tags, never the text.
      console.warn(
        "[analyze] English POS tagging unavailable; falling back to segmentation.",
        err
      );
    }
  }
  return segmentOnly(text, lang);
}
