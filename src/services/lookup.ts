// Lookup / read-only translation: surface meanings for DISPLAY without saving to the
// user's vocabulary. `lookupWord` returns every meaning of a word; `translateParagraph`
// returns a whole-paragraph gloss (never persisted) plus a word → meanings lookup.
// Saving is a separate, explicit step (userWords.saveDictionaryWord).

import {
  resolveSourceLanguage,
  analyze,
  splitSentences,
  AUTO_DETECT,
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
  const proposed = dictionaryCompoundCandidates(tokens);
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
  return mergeConfirmedCompounds(tokens, confirmed);
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
    const rest = missing.filter((k) => !isKatakanaOnly(k));
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
      if (!isDictionaryForm) continue;
      const senses = meaningsByKey.get(keyOf(token)) ?? [];
      const distinct = [...new Set(senses.map((s) => s.inputReading).filter(Boolean))];
      if (distinct.length === 1) token.reading = distinct[0];
    }
  }

  // 4. Key by the shared wordKey (lemma, lowercased) so every surface of one word —
  //    "Cats", "cats", "cat" — resolves to a single entry. Callers use the same helper.
  const meanings = new Map<string, Word[]>();
  for (const token of tokens) {
    const key = wordKey(token);
    if (!meanings.has(key)) {
      const senses = meaningsByKey.get(keyOf(token)) ?? [];
      meanings.set(key, isJunkKatakana(token.text, senses) ? [] : senses);
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
