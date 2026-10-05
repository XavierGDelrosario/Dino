// Lookup / read-only translation: surface meanings for DISPLAY without saving to the
// user's vocabulary. `lookupWord` returns every meaning of a word; `translateParagraph`
// returns a whole-paragraph gloss (never persisted) plus a word → meanings lookup.
// Saving is a separate, explicit step (userWords.saveDictionaryWord).

import {
  resolveSourceLanguage,
  analyze,
  splitSentences,
  AUTO_DETECT,
  isContentPos,
  type LangCode,
  type SourceSelection,
  type AnalyzedToken,
} from "./language";
import {
  dictionaryCompoundCandidates,
  mergeConfirmedCompounds,
} from "./language/compounds";
import {
  findWordTranslations,
  findWordTranslationsBatch,
  type Word,
} from "./words/repository";
import {
  setCachedSenses,
  isKnownDictionaryMiss,
  markDictionaryMiss,
} from "./words/cache";
import { applyReadingOverride, applyWritingOverride } from "./language/readingOverrides";
import { isKatakanaOnly, nfc, nfcTrim } from "../lib/text";
import { translateBatch, glossSentences } from "./translation";
import { resolveSenseProvider } from "./senses";

/**
 * EVERY known meaning of a word, so the UI can show them all — the preferred entry may
 * be wrong, so the user picks. An uncached word is translated once to seed a meaning.
 * Adds nothing to the user's vocabulary; may populate the global dictionary cache.
 */
export async function lookupWord(params: {
  input: string;
  targetLang: LangCode;
  sourceLang?: SourceSelection;
}): Promise<{
  input: string;
  sourceLang: LangCode;
  targetLang: LangCode;
  meanings: Word[];
}> {
  const { targetLang, sourceLang = AUTO_DETECT } = params;
  const input = nfcTrim(params.input);
  const resolvedSource = resolveSourceLanguage(input, sourceLang);

  let meanings = await findWordTranslations({
    input,
    sourceLang: resolvedSource,
    targetLang,
  });

  // Nothing cached: ask this pair's sense provider. A real dictionary returns ALL
  // senses; the MT fallback returns one.
  if (meanings.length === 0) {
    meanings = await resolveSenseProvider(resolvedSource, targetLang)(
      input,
      resolvedSource,
      targetLang
    );
    setCachedSenses(input, resolvedSource, targetLang, meanings); // memoize for repeats
  }

  // Hand-verified fix for common standalone words that lose jmdict_lookup's frequency
  // tiebreak (前 → さき not まえ; ところ → 野老 not 所). The reading override fixes a
  // wrong READING, the writing override a wrong WORD for a kana search. Both reorder
  // the PRIMARY sense only, and a surface is in at most one list.
  return {
    input,
    sourceLang: resolvedSource,
    targetLang,
    meanings: applyWritingOverride(input, applyReadingOverride(input, meanings)),
  };
}

/**
 * Batched `lookupWord` for MANY words of the SAME pair: all senses per word,
 * cache-then-seed, but resolved in ONE `.in()` read plus ONE batched edge call for the
 * misses. `sourceLang` must be concrete. Inputs with no result are absent from the map;
 * an edge failure is non-fatal (the already-cached words still resolve).
 */
export async function lookupWordsBatch(params: {
  inputs: string[];
  sourceLang: LangCode;
  targetLang: LangCode;
}): Promise<Map<string, Word[]>> {
  const { sourceLang, targetLang } = params;
  const inputs = [
    ...new Set(params.inputs.map(nfcTrim).filter(Boolean)),
  ];
  if (inputs.length === 0) return new Map();

  // Cached senses (client cache + one .in() read), then ONE edge call for the rest.
  const byWord = await findWordTranslationsBatch({ inputs, sourceLang, targetLang });
  const missing = inputs.filter((k) => !byWord.has(k));
  if (missing.length > 0) {
    try {
      const seeded = await translateBatch({ inputs: missing, sourceLang, targetLang });
      for (const key of missing) {
        const senses = seeded.get(key) ?? [];
        if (senses.length > 0) {
          byWord.set(key, senses);
          setCachedSenses(key, sourceLang, targetLang, senses); // memoize for repeats
        }
      }
    } catch {
      /* edge failure is non-fatal — the cached candidates still resolve */
    }
  }
  // The same hand-verified primary fixes lookupWord applies, so a word's default
  // meaning is the same looked up alone or met in a sentence (すぎ led with a fish in
  // the reader long after ところ was fixed for single lookups).
  for (const [key, senses] of byWord) {
    const fixed = applyWritingOverride(key, applyReadingOverride(key, senses));
    if (fixed !== senses) byWord.set(key, fixed);
  }
  return byWord;
}

/** One sentence of the paragraph with its own gloss (null = not translated). */
export interface SentenceGloss {
  text: string;
  /** Offsets into the paragraph, so the reader can group tokens per sentence. */
  start: number;
  end: number;
  gloss: string | null;
}

export interface ParagraphTranslation {
  /** Contextual translation of the WHOLE paragraph, for display only. NOT saved. */
  translation: string;
  /** false when the paragraph couldn't be translated (translation = input). */
  translated: boolean;
  /** The same translation SENTENCE BY SENTENCE, each its own translation unit so
   *  `sentences[i].gloss` provably belongs to `sentences[i].text`. */
  sentences: SentenceGloss[];
  sourceLang: LangCode;
  targetLang: LangCode;
  /** Each word occurrence in reading order, with offsets and a best-effort
   *  reading/lemma. These readings are statistical DISPLAY hints, not authoritative
   *  like the verified `words` readings. */
  tokens: AnalyzedToken[];
  /** Lookup from a word's text to all its known meanings (verified first). */
  meanings: Map<string, Word[]>;
}

/**
 * Collapse the per-sentence glosses into the ONE paragraph string the output box
 * shows. A failed sentence contributes its SOURCE text, so a partial failure reads as
 * one untranslated line rather than a hole; `translated` is false only when nothing
 * landed at all (keeping the contract: translation = input on failure).
 */
function joinGloss(
  sentences: SentenceGloss[],
  input: string,
): { translation: string; translated: boolean } {
  const any = sentences.some((s) => s.gloss);
  if (!any) return { translation: input, translated: false };
  return { translation: sentences.map((s) => s.gloss ?? s.text).join(" "), translated: true };
}

/**
 * A katakana surface the DICTIONARY lacks is a name, a brand or a one-off
 * transliteration, not vocabulary — measured on ja.wikinews, ~32 of 35 such surfaces
 * were proper nouns. Showing them floods an article's word list, and the MT gloss they
 * would get ("ゼレンスキー" → "Zelensky") teaches nothing, costs a paid call and leaves a
 * POS-less row in the shared cache forever.
 *
 * IDENTIFIED by having no part-of-speech: POS comes from the dictionary projection, so
 * a sense without one came from MT. Frequency would be the WRONG test: ゼロ and フェロー
 * are real JMdict entries carrying no wordfreq score.
 *
 * That "no POS ⟺ MT" equivalence holds for JA→EN only, which is all this needs — the
 * surface test below is katakana-only, and an EN→JA row's input is English. Since
 * migration 20260760 an EN→JA row's POS is the ENGLISH word's class from WordNet, so a
 * lemma WordNet lacks now projects a dictionary row with NULL POS. Don't lift this
 * identification to the other direction.
 *
 * SCOPED to katakana, and to the READER. The same rule over every script would gut dev
 * and local, where the `-common-` subset leaves real words (唐揚げ) MT-covered; and
 * typing a name into Translate still answers, since that lookup is a question the user
 * asked (cf. the person-name POS demotion in analyze.ts).
 */
function isJunkKatakana(surface: string, senses: Word[]): boolean {
  return (
    senses.length > 0 &&
    isKatakanaOnly(surface) &&
    senses.every((s) => !s.partOfSpeech || s.partOfSpeech.length === 0)
  );
}

/**
 * True for a PROPER NOUN the dictionary does not know — every sense is machine
 * translation (no POS; see isJunkKatakana for why "no POS" identifies MT here).
 * Quality reports #25–#28: 大東, 東島, 琉球新報 were offered as vocabulary with an MT
 * "meaning" that is just the romanized name ("Daito"). A place the dictionary DOES know
 * (東京, アメリカ) has POS'd senses and stays; so does a real word IPADIC mis-tags as a
 * name, as long as JMdict has it. Gated on the analyzer's proper-noun tag, so a real
 * word left MT-only by the dev `-common-` subset (唐揚げ) is untouched.
 */
function isUnknownName(token: AnalyzedToken, senses: Word[]): boolean {
  return (
    (token.properNoun === true || isNameFragment(token)) &&
    senses.length > 0 &&
    senses.every((s) => !s.partOfSpeech?.length)
  );
}

const HAS_KANJI = /\p{Script=Han}/u;

/** A lone kanji kuromoji had no entry for — a name fragment or variant glyph (倖田來未
 *  → 倖 田 來 未, reports #34/#35), not a word anyone is studying. */
function isNameFragment(t: AnalyzedToken): boolean {
  return t.unknownWord === true && [...t.text].length === 1 && HAS_KANJI.test(t.text);
}

/**
 * May a dictionary MISS for this token be bought from paid MT? Only for a content word
 * that isn't a name. Names (English PROPN, Japanese 固有名詞 incl. the demoted
 * 人名/組織/地名), grammar, bare counters (人組) and name fragments are still LOOKED UP —
 * a name the dictionary knows stays — but a miss greys out instead of buying "Kanako".
 * On prod this rule was English-only, and 33 romanized-name MT rows were bought after
 * the Japanese name demotions shipped (加奈子, 和雄, 富士吉田, …).
 */
function isMtWorthy(t: AnalyzedToken): boolean {
  return (
    isContentPos(t.pos) &&
    t.pos !== "PROPN" &&
    !t.properNoun &&
    !t.counter &&
    !t.composite &&
    !isNameFragment(t)
  );
}

/** JMdict entry ids from 5,000,000 up are the named entities merged in from JMnedict
 *  (companies, products, works — エールフランス, 読売新聞). Not vocabulary for the reader.
 *  Measured against JMdict's own name misc tags (jmdict-eng 3.6.2+20260928): 7,303 of
 *  the 7,304 entries in the range carry one (the outlier is the ＪＭｄｉｃｔ metadata
 *  entry, 9999999), and below it only a few dozen do (ガリレオ, シューベルト — famous
 *  people a learner may want). So the range IS the tag set; ingesting the tags would buy
 *  nothing. ⚠️ `fem`/`masc` are NOT name tags — they mark feminine/masculine speech
 *  (あら, かしら). Reader only, deliberately: an explicit lookup of 読売新聞 is a question
 *  the user asked, and answers it. */
function isNamedEntitySense(s: Word): boolean {
  return Number(s.jmdictEntryId ?? 0) >= 5_000_000;
}

/** A sense whose only POS is a prefix — キロ "kilo-". After a number (三キロ) the word is
 *  a unit, never the prefix (report #31), so such senses sort last for counters. */
function isPrefixOnly(s: Word): boolean {
  return (s.partOfSpeech?.length ?? 0) > 0 && s.partOfSpeech!.every((p) => p === "pref");
}

/** JMdict POS tags for function words — a particle, an auxiliary, the copula. */
const GRAMMAR_POS = new Set(["prt", "aux", "aux-v", "aux-adj", "cop"]);

/**
 * True when EVERY sense the dictionary gave for a reader token is a function word —
 * quality report #29, 乃: JMdict has it only as the particle の, but IPADIC tags it an
 * unknown NOUN, so the POS gate in the reader waves it through and it is offered as
 * vocabulary. The analyzer's POS is the first gate; this lets the DICTIONARY overrule
 * it when the analyzer had no idea. A word with even one content sense stays (の as a
 * noun is not a thing, but a homograph with one real meaning must remain addable), and
 * a sense with no POS at all (an MT row) never counts as grammar.
 */
function isGrammarOnly(senses: Word[]): boolean {
  return (
    senses.length > 0 &&
    senses.every((s) => (s.partOfSpeech?.length ?? 0) > 0 && s.partOfSpeech!.every((p) => GRAMMAR_POS.has(p)))
  );
}

/**
 * Ask the dictionary which of kuromoji's adjacent-noun runs are actually ONE word and
 * merge those — the I/O half of the compound fix (the span logic is pure, in
 * language/compounds.ts).
 *
 * Probes resolve cache-first, then by a DICTIONARY-ONLY batch: a probe is a guess
 * ("could 柔軟剤 be a word?") and most guesses miss, so they must never reach paid MT.
 * Confirmed probes are memoized, so the merged compound is already cached when the main
 * lookup runs. A failure is NON-FATAL — tokens come back unmerged.
 */
async function mergeDictionaryCompounds(
  tokens: AnalyzedToken[],
  sourceLang: LangCode,
  targetLang: LangCode,
): Promise<AnalyzedToken[]> {
  const proposed = [
    ...new Set([
      ...dictionaryCompoundCandidates(tokens),
      // A number+counter can be its OWN headword — 三人組 "trio", while its counter half
      // 人組 is not an entry at all (report #36). Probe the whole surface too.
      ...tokens.filter((t) => t.composite).map((t) => t.text),
    ]),
  ];
  // Drop guesses the dictionary already rejected this session. Re-analyzing the
  // same text otherwise re-asks every wrong guess, and most guesses are wrong.
  const candidates = proposed.filter((c) => !isKnownDictionaryMiss(c, sourceLang, targetLang));
  if (candidates.length === 0) return tokens;

  const confirmed = new Set<string>();
  try {
    const cached = await findWordTranslationsBatch({
      inputs: candidates,
      sourceLang,
      targetLang,
    });
    for (const [surface, senses] of cached) {
      if (senses.length > 0) confirmed.add(surface);
    }
    const unknown = candidates.filter((c) => !confirmed.has(c));
    if (unknown.length > 0) {
      const batch = await translateBatch({
        inputs: unknown,
        sourceLang,
        targetLang,
        dictionaryOnly: true, // probes never hit paid MT — see the note above
      });
      for (const surface of unknown) {
        const senses = batch.get(surface) ?? [];
        if (senses.length > 0) {
          confirmed.add(surface);
          setCachedSenses(surface, sourceLang, targetLang, senses);
        } else {
          // Authoritative "no such entry" — this call never falls through to MT, so
          // the answer can't change this session.
          markDictionaryMiss(surface, sourceLang, targetLang);
        }
      }
    }
  } catch {
    return tokens; // probe failed → leave segmentation as kuromoji had it
  }
  // A confirmed number+counter looks itself up (三人組), not its counter (人組).
  const promoted = tokens.map((t) =>
    t.composite && confirmed.has(t.text) ? { ...t, lemma: t.text, lemmaReading: undefined, composite: undefined } : t,
  );
  return mergeConfirmedCompounds(promoted, confirmed);
}


/** A reading we may print as furigana: present, and no kanji in it. */
function isKanaReading(r: string | null): r is string {
  return r !== null && r !== "" && !HAS_KANJI.test(r);
}

/**
 * How `sense` reads the spelling `surface`, or null.
 *
 * `inputReading` is "the OTHER form shown beside the headword", not always a reading.
 * A normal entry headwords as kanji with the kana there (猫 / ねこ); a `uk` entry is the
 * inverse — kana headword, KANJI there (おおむね / 概ね). Reading it straight put 概ね
 * over 概ね as its own furigana, and counted a uk entry's kanji as a candidate reading,
 * so 為 looked unambiguous (い) when ため and す share the spelling too.
 */
function readingOfSpelling(sense: Word, surface: string): string | null {
  if (sense.input === surface) return sense.inputReading;
  if (sense.inputReading === surface) return sense.input; // uk: the headword IS the reading
  return null;
}

/**
 * Translates a paragraph two ways: the WHOLE paragraph in context for display only
 * (NEVER persisted — we won't store thousands of unique paragraphs), and each distinct
 * WORD with all its meanings, which ARE cached as verified words. Returns the tokens
 * with positions plus a word → meanings lookup; rendering is the frontend's call.
 * Adds nothing to the user's vocabulary. Assumes one language per paragraph.
 */
/**
 * The key a token's meanings are stored and looked up under — by everything: the
 * reader, the quiz picker, the word list, the summary.
 *
 * Two tokens that are the SAME WORD must land on one entry, and the surface alone
 * doesn't do that. It forked on case ("Cats" at the start of a sentence vs "cats" in
 * the middle) and on inflection ("cat" vs "cats"), so one word became two hover cards,
 * two quiz cards and two rows in the word list — with identical meanings, which reads
 * as a bug rather than a distinction.
 *
 * LEMMA FIRST, then lowercased. The lemma is what collapses cat/cats; the lowercasing
 * is what collapses Cats/cats. Both are safe for Japanese: kuromoji already supplies a
 * lemma, and lowercasing is a no-op on kana and kanji.
 *
 * ‼️ Display still uses `token.text` — this is the KEY, not the label. A word is shown
 * exactly as it was written; only its meanings are shared.
 */
export function wordKey(token: { text: string; lemma?: string | null }): string {
  return nfc(token.lemma ?? token.text).toLowerCase();
}

export async function translateParagraph(params: {
  input: string;
  targetLang: LangCode;
  sourceLang?: SourceSelection;
  /** Pre-computed analysis of `input`, to skip a duplicate kuromoji tokenize when the
   *  caller already analyzed the same string (e.g. submit's word-vs-sentence routing). */
  tokens?: AnalyzedToken[];
  /** Fired the moment the gloss lands — BEFORE the slower analysis + per-word lookups —
   *  so the UI can show the translation and stream the reader in after. */
  onGloss?: (gloss: { translation: string; translated: boolean }) => void;
  /** Skip the paragraph gloss entirely (no MT call) for surfaces that only need the
   *  per-word reader, so opening one costs zero MT. */
  skipGloss?: boolean;
  /** CACHE + DICTIONARY only — a word JMdict lacks returns no meanings instead of
   *  falling through to paid MT. For text the user hasn't asked to translate: the LIVE
   *  reader runs on every typing pause, so half-typed words (唐, 唐揚) would otherwise
   *  bill Google on the way to one real word. Same seam as the compound probes. */
  dictionaryOnly?: boolean;
}): Promise<ParagraphTranslation> {
  const { targetLang, sourceLang = AUTO_DETECT } = params;
  const input = nfc(params.input);
  const resolvedSource = resolveSourceLanguage(input, sourceLang);

  // 1. Kick off the gloss WITHOUT awaiting: the reader below doesn't depend on it, so
  //    the slowest call runs CONCURRENTLY with analysis + lookups instead of in front
  //    of them. onGloss streams it in; a failure is non-fatal.
  //
  //    SENTENCE BY SENTENCE, not one blob, so the reader can print the English under
  //    the Japanese it belongs to. Still ONE round-trip and the same billed chars.
  //    SPLITTING IS FREE; only the gloss costs — so the spans always come back (with
  //    null glosses under skipGloss), because the reader draws its per-sentence
  //    controls from them and a skipGloss surface would otherwise have nothing to tap.
  const sentenceSpans = splitSentences(input);
  const glossPromise: Promise<SentenceGloss[]> =
    params.skipGloss || sentenceSpans.length === 0
      ? Promise.resolve(sentenceSpans.map((s) => ({ ...s, gloss: null })))
      : // Through the CACHE, not the raw client: this is the same content the reader's
        // per-sentence taps buy, so going direct paid for the same text twice.
        glossSentences({
          segments: sentenceSpans.map((s) => s.text),
          sourceLang: resolvedSource,
          targetLang,
        })
          .then((glosses) => sentenceSpans.map((s, i) => ({ ...s, gloss: glosses[i] ?? null })))
          .catch(() => sentenceSpans.map((s) => ({ ...s, gloss: null })))
          .then((sentences) => {
            params.onGloss?.(joinGloss(sentences, input));
            return sentences;
          });

  // 2. Tokens: reuse the caller's analysis when given, else analyze here. Offsets stay
  //    pointed at the original paragraph; for JA this also yields reading + lemma.
  let tokens = params.tokens ?? (await analyze(input, resolvedSource));

  // 2b. Re-merge compounds kuromoji over-segmented, validated against the DICTIONARY
  //     (柔軟 ＋ 剤 → 柔軟剤). Without it the reader looks up the fragments and the
  //     word's meaning is lost — the top source of quality reports. Generalizes the
  //     curated list in compounds.ts, which runs first inside analyze.
  if (resolvedSource.toUpperCase() === "JA") {
    tokens = await mergeDictionaryCompounds(tokens, resolvedSource, targetLang);
  }

  // 3. Look each word up by its LEMMA when known (行った resolves via 行く), else its
  //    surface. The dictionary is keyed on dictionary forms; results are re-exposed
  //    under the surface text below.
  const keyOf = (t: AnalyzedToken) => nfc(t.lemma ?? t.text);
  const uniqueKeys = [...new Set(tokens.map(keyOf))];

  // Keys that MAY escalate a miss to paid MT: those used by at least one content,
  // non-name token (isMtWorthy). Every other key still gets looked UP — a name the
  // dictionary knows (Japan, 東京) is ordinary vocabulary and must stay addable — it
  // simply never buys a MISS. Measured on en.wikinews, 23.5% of lookup keys miss the
  // dictionary against 5.5% for Japanese, and the misses are overwhelmingly names, each
  // one a billed Google call cached as a verified row the reader then offers to save.
  //
  // Keyed by keyOf, not by surface, because that is what `missing` holds.
  const mtKeys = new Set(tokens.filter(isMtWorthy).map(keyOf));

  // All meanings in ONE query (client cache + a single .in() read); the misses take ONE
  // batched edge call below, so a long paragraph costs two round-trips, not hundreds.
  const meaningsByKey = await findWordTranslationsBatch({
    inputs: uniqueKeys,
    sourceLang: resolvedSource,
    targetLang,
  });
  const missing = uniqueKeys.filter((k) => !meaningsByKey.has(k));
  if (missing.length > 0) {
    // ONE batched edge call for the uncached words — except katakana, which goes in a
    // second DICTIONARY-ONLY batch (see isJunkKatakana). Both fly in parallel, so the
    // split costs no latency. A failure is non-fatal: those words render uncolored.
    const katakana = missing.filter(isKatakanaOnly);
    const dictOnly = missing.filter((k) => !isKatakanaOnly(k) && !mtKeys.has(k));
    const rest = missing.filter((k) => !isKatakanaOnly(k) && mtKeys.has(k));
    try {
      const batches = await Promise.all([
        rest.length > 0
          ? translateBatch({
              inputs: rest,
              sourceLang: resolvedSource,
              targetLang,
              dictionaryOnly: params.dictionaryOnly,
            })
          : null,
        katakana.length > 0
          ? translateBatch({
              inputs: katakana,
              sourceLang: resolvedSource,
              targetLang,
              dictionaryOnly: true, // a katakana miss never reaches paid MT
            })
          : null,
        dictOnly.length > 0
          ? translateBatch({
              inputs: dictOnly,
              sourceLang: resolvedSource,
              targetLang,
              dictionaryOnly: true, // nor does a name/grammar/counter miss (see mtKeys)
            })
          : null,
      ]);
      for (const batch of batches) {
        if (!batch) continue;
        for (const [key, senses] of batch) {
          if (senses.length > 0) {
            meaningsByKey.set(key, senses);
            setCachedSenses(key, resolvedSource, targetLang, senses); // memoize for repeats
          }
        }
      }
    } catch {
      /* leave the uncached words without meanings */
    }
  }

  // 3b. Overlay the AUTHORITATIVE reading already riding on the looked-up senses (no
  //     extra query), under two guards: only when the surface IS the dictionary form
  //     (the stored reading is the HEADWORD's, so 行った must keep いった, not いく), and
  //     only when the senses agree on a SINGLE reading — a homograph like 辛い defers to
  //     kuromoji's context. JA only.
  if (resolvedSource.toUpperCase() === "JA") {
    for (const token of tokens) {
      const isDictionaryForm = token.lemma === null || token.lemma === token.text;
      // A token with no kanji needs no furigana — and its "dictionary reading" would be
      // a uk entry's KANJI (くだり → 件), which is what the reader used to print over it.
      if (!isDictionaryForm || !HAS_KANJI.test(token.text)) continue;
      const senses = meaningsByKey.get(keyOf(token)) ?? [];
      const distinct = [
        ...new Set(senses.map((s) => readingOfSpelling(s, token.text)).filter(isKanaReading)),
      ];
      if (distinct.length === 1) token.reading = distinct[0];
    }
  }

  // 4. Key by the shared wordKey (lemma, lowercased) so every surface of one word —
  //    "Cats", "cats", "cat" — resolves to a single entry. Callers use the same helper.
  const meanings = new Map<string, Word[]>();
  for (const token of tokens) {
    const key = wordKey(token);
    if (!meanings.has(key)) {
      let senses = (meaningsByKey.get(keyOf(token)) ?? []).filter((s) => !isNamedEntitySense(s));
      if (token.composite) senses = [...senses.filter((s) => !isPrefixOnly(s)), ...senses.filter(isPrefixOnly)];
      const drop = isJunkKatakana(token.text, senses) || isGrammarOnly(senses) || isUnknownName(token, senses);
      meanings.set(key, drop ? [] : senses);
    }
  }

  // Fold in the gloss — awaited here, but usually already resolved in parallel.
  const sentences = await glossPromise;
  const joined = joinGloss(sentences, input);
  return {
    translation: joined.translation,
    translated: joined.translated,
    sentences,
    sourceLang: resolvedSource,
    targetLang,
    tokens,
    meanings,
  };
}
