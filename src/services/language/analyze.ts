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
import { loadEnglishBaseForms, readerLemma } from "./lemmaEn";
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
  /** On a `composite` token: the COUNTER's own citation reading (本 → ほん, 条 → じょう),
   *  since `reading` is the euphonic whole (さんぼん). This is what matches a sense's
   *  dictionary reading when ordering senses by context (analyze/senseOrder.ts). */
  lemmaReading?: string | null;
  /** True when IPADIC tags the token a PROPER NOUN (名詞-固有名詞, any subcategory).
   *  People and organizations are already demoted off content POS (see PERSON_NAME_POS);
   *  this carries the fact for the ones that keep it — places (大東) and IPADIC's
   *  catch-all — so the reader can drop a name the DICTIONARY doesn't know either
   *  (lookup.ts, isUnknownName). Absent on every other token. */
  properNoun?: boolean;
  /** Set on a token demoted off content POS because it is a PERSON's or an
   *  ORGANIZATION's name (PERSON_NAME_POS / ORGANIZATION_POS). It is still not
   *  vocabulary — nothing counts it or adds it automatically — but the reader shows it
   *  as a name with its reading, and it can be added by hand (lookup.ts, `names`). */
  nameKind?: "person" | "organization";
  /** True when kuromoji had NO dictionary entry for the token (word_type UNKNOWN). A
   *  lone unknown kanji is almost always a name fragment or a variant glyph — 倖田來未
   *  lattices as 倖 田 來 未 with 倖 and 來 unknown (quality reports #34/#35) — so the
   *  reader never pays MT for one and drops it when only MT knows it (lookup.ts). */
  unknownWord?: boolean;
  /** True for a bare counter IPADIC tags 名詞-接尾-助数詞 (人組 in 3人組). A counter is
   *  not a headword on its own, so a dictionary miss must not be bought from MT
   *  (report #36: 人組 → paid "Group"). Composite number+counter tokens carry
   *  `composite` instead. */
  counter?: boolean;
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
  // greys out — it just never reaches the paid MT fallback. See isMtWorthy() in
  // lookup.ts and the edge's skipMt handling.
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
    lemma: readerLemma(t.text, { lang }),
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

// …and a third, for PLACES — but only with a municipal suffix after them. 地域 keeps its
// content POS on purpose (東京, アメリカ are vocabulary), yet 笛吹市 / 大和村 / 甲斐市
// are names whose homograph is a real word — "flute player", "(ancient) Japan", "worth"
// (quality reports #38–#40) — and the reader offered the word. The suffix is the one
// context signal kuromoji gives: 市/町/村/区/郡 head a municipality. 都/道/府/県 are left
// out deliberately — 東京都, 山梨県 name prefectures a learner does want. Known gap: the
// same name with no suffix (大和 alone) still reads as the word.
const PLACE_NAME_POS = "地名";
const MUNICIPAL_SUFFIX = new Set(["市", "町", "村", "区", "郡"]);

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
    // The NOMINALIZER の (and its contraction ん) is grammar too. IPADIC tags it
    // 名詞-非自立 — "行くのが好き", "安いのを買った", "行くんです" — so it passed as a noun,
    // and its lookup found the homophones (野 "field", 乃) and offered THOSE as the
    // word. As a particle (私の本) it was already 助詞 and plain text; the same two
    // characters read as vocabulary or not depending on the clause. Only の / ん: the
    // other dependent nouns (こと, もの, ため, はず, わけ) are words a learner studies.
    if (pos === "名詞" && t.pos_detail_1 === "非自立" && (t.surface_form === "の" || t.surface_form === "ん")) {
      pos = "助詞";
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
      ...(t.pos === "名詞" && t.pos_detail_1 === "固有名詞" ? { properNoun: true } : {}),
      ...(pos === PERSON_NAME_POS ? { nameKind: "person" as const } : {}),
      ...(pos === ORGANIZATION_POS ? { nameKind: "organization" as const } : {}),
      ...(t.word_type === "UNKNOWN" ? { unknownWord: true } : {}),
      ...(isCounterToken(t) ? { counter: true } : {}),
    });
    kept.push(t);
  }
  demoteMunicipalNames(out, kept);
  applyCounterReadings(out, kept);
  // Re-merge whole words IPADIC over-segmented (大規模 → 大＋規模) BEFORE lookup — a
  // curated compound pass, since kuromoji.js has no user dictionary.
  return mergeJapaneseCompounds(
    mergeMisparsedPotentials(mergeCounterTokens(out, kept), tokenizer),
  );
}

/** 固有名詞-地域 directly followed by a 接尾-地域 市/町/村/区/郡 → a place NAME (see
 *  PLACE_NAME_POS). `kept` is parallel to `out`. */
function demoteMunicipalNames(out: AnalyzedToken[], kept: IpadicFeatures[]): void {
  for (let i = 0; i + 1 < kept.length; i++) {
    const t = kept[i];
    const next = kept[i + 1];
    if (
      t.pos_detail_1 === "固有名詞" && t.pos_detail_2 === "地域" &&
      next.pos_detail_1 === "接尾" && next.pos_detail_2 === "地域" &&
      MUNICIPAL_SUFFIX.has(next.surface_form) && out[i].end === out[i + 1].start
    ) {
      out[i].pos = PLACE_NAME_POS;
    }
  }
}

/**
 * Re-join a POTENTIAL verb IPADIC split in two (quality report #20: 活かせる).
 *
 * kuromoji knows 活かす — 活かせます and 活かして parse fine — but the plain potential
 * 活かせる comes out as one of two wrong splits, and neither half looks up anything:
 *   A. 活か (動詞, lemma 活かる) + せる (助動詞)   — mid-sentence: スキルを活かせる
 *   B. 活 (名詞) + かせる (動詞)                   — sentence-final or alone
 *
 * Both are rewritten to ONE verb token whose lemma is the 〜す base, but only when
 * kuromoji itself parses that base as a single verb with that dictionary form. The
 * analyzer vouching for the word is what keeps this from inventing joins.
 *
 * A is further pinned to its misparse signature — a lemma that is just the surface + る
 * (一段-shaped) — because a real causative (読ま + せる, lemma 読む) must stay the verb
 * 読む plus grammar. A 一段 verb's own causative takes させる, never せる, so that
 * signature doesn't occur in correct parses.
 */
function mergeMisparsedPotentials(
  tokens: AnalyzedToken[],
  tokenizer: Tokenizer<IpadicFeatures>,
): AnalyzedToken[] {
  const out: AnalyzedToken[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const a = tokens[i];
    const b = tokens[i + 1];
    if (!b || a.end !== b.start) {
      out.push(a);
      continue;
    }
    let base: string | null = null;
    if (a.pos === "動詞" && b.pos === "助動詞" && b.text === "せる" && a.lemma === `${a.text}る`) {
      base = `${a.text}す`; // A: 活か + せる → 活かす
    } else if (
      a.pos === "名詞" && b.pos === "動詞" && b.lemma !== null &&
      b.lemma.length > 2 && b.lemma.endsWith("せる") &&
      // Keyed on b's LEMMA, not its surface: the conditional 活かせれば comes out as
      // 活 + かせれ (lemma かせる) + ば, and a surface test missed it.
      b.text.startsWith(b.lemma.slice(0, -1))
    ) {
      base = `${a.text}${b.lemma.slice(0, -2)}す`; // B: 活 + かせる/かせれ → 活かす
    }
    const reading = base ? singleVerbReading(tokenizer, base) : undefined;
    if (base === null || reading === undefined) {
      out.push(a);
      continue;
    }
    // Whatever b conjugated after its せ (る, れ, …) rides on the merged reading.
    const tail = b.text.slice(b.text.lastIndexOf("せ") + 1);
    out.push({
      text: a.text + b.text,
      start: a.start,
      end: b.end,
      reading: reading === null ? null : `${reading.slice(0, -1)}せ${tail}`,
      lemma: base,
      pos: "動詞",
    });
    i += 1; // b is folded in
  }
  return out;
}

/**
 * If kuromoji parses `verb` as exactly one 動詞 in dictionary form, its hiragana reading
 * (null when it has none, or it doesn't end in す); otherwise undefined.
 */
function singleVerbReading(
  tokenizer: Tokenizer<IpadicFeatures>,
  verb: string,
): string | null | undefined {
  const parsed = tokenizer.tokenize(verb);
  if (parsed.length !== 1) return undefined;
  const [t] = parsed;
  if (t.pos !== "動詞" || t.basic_form !== verb || t.surface_form !== verb) return undefined;
  const reading = t.reading && t.reading !== UNKNOWN ? katakanaToHiragana(t.reading) : null;
  return reading !== null && reading.endsWith("す") ? reading : null;
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
    if (!isCounterToken(c)) continue;
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
      lemmaReading: citationReading(kept[i]),
      pos: out[i].pos,
      composite: true,
    });
  }
  return result;
}

/** IPADIC's counter (助数詞) tag: 本, 条, 人組 — a suffix after a number. */
function isCounterToken(t: IpadicFeatures): boolean {
  return t.pos === "名詞" && t.pos_detail_1 === "接尾" && t.pos_detail_2 === "助数詞";
}

/** kuromoji's own (citation) reading of a raw token, in hiragana, or null. */
function citationReading(t: IpadicFeatures): string | null {
  return t.reading && t.reading !== UNKNOWN ? katakanaToHiragana(t.reading) : null;
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
    if (!isCounterToken(c)) {
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

  // The lemma verifier (WordNet base forms) rides the same lazy path as the model;
  // without it the tag-gated lemma rules simply don't fire.
  await loadEnglishBaseForms().catch(() => {});
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
    // The tag is what lets regular -ing/-ed/-es resolve (lemmaEn.ts): a VERB form is
    // lemmatized, a NOUN that happens to end in -ing (building) is left as the word it is.
    lemma: readerLemma(t.text, { lang, tag: tags[i] }),
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
