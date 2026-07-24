// =========================================================
// DINO lookup / read-only translation.
//
// Translate for DISPLAY and surface meanings WITHOUT saving to the user's
// lists. `lookupWord` returns every meaning of a word; `translateParagraph`
// returns a whole-paragraph contextual translation (NOT persisted) plus a
// word -> meanings lookup. Saving a chosen word is a separate, explicit step
// (userWords.saveDictionaryWord). Translation is delegated to the backend.
// =========================================================

import {
  resolveSourceLanguage,
  analyze,
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
import { nfc, nfcTrim } from "../lib/text";
import { translate, translateBatch } from "./translation";
import { resolveSenseProvider } from "./senses";

/**
 * Looks up EVERY known meaning of a word so the UI can show them all — the
 * first/preferred entry may be wrong, so the user picks. If the word isn't
 * cached yet it is translated once to seed a meaning.
 *
 * Read-only with respect to the user's vocabulary: this never adds anything.
 * Saving a chosen meaning is a separate, explicit step
 * (userWords.saveDictionaryWord). It may populate the global dictionary cache.
 *
 * OUTPUT: { input, sourceLang, targetLang, meanings: Word[] }.
 * CONSTRAINTS: NFC-normalizes; saves nothing to user lists; may cache globally.
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

  // Nothing cached yet: ask the sense provider for this language pair to fetch
  // (and cache) the word's senses. A real dictionary returns ALL senses; the MT
  // fallback returns one (see senses/registry.ts).
  if (meanings.length === 0) {
    meanings = await resolveSenseProvider(resolvedSource, targetLang)(
      input,
      resolvedSource,
      targetLang
    );
    // Prime the read cache with the freshly-fetched senses so a repeat lookup of
    // the same term this session skips the round-trip the DB read just missed.
    setCachedSenses(input, resolvedSource, targetLang, meanings);
  }

  // TEMPORARY hand-verified fix for the no-context default reading of a handful
  // of common standalone words that lose jmdict_lookup's frequency tiebreak
  // (前 → さき instead of まえ; もの → 者 instead of 物; ところ → 野老 yam instead of
  // 所). The reading override fixes wrong-READING kanji; the writing override fixes
  // wrong-WORD kana searches (whose candidates share a reading). Both reorder the
  // PRIMARY sense only; no-op otherwise, and a surface is in at most one list.
  return {
    input,
    sourceLang: resolvedSource,
    targetLang,
    meanings: applyWritingOverride(input, applyReadingOverride(input, meanings)),
  };
}

/**
 * Batched `lookupWord` for MANY words of the SAME language pair (the EN→JA
 * fan-out's stage 2: study every candidate equivalent at once). Mirrors
 * lookupWord — all senses per word, cache-then-seed — but resolves the whole set
 * in ONE `.in()` DB read plus ONE batched edge call for the misses, instead of a
 * per-word lookup each with its own round-trips.
 *
 * OUTPUT: Map<input, Word[]> — every input that resolved maps to its senses
 * (verified first); inputs with no result are simply absent.
 * CONSTRAINTS: `sourceLang` must be concrete; saves nothing to user lists; may
 * populate the global dictionary cache. An edge failure is non-fatal (the
 * already-cached words still resolve).
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

export interface ParagraphTranslation {
  /** Contextual translation of the WHOLE paragraph, for display only. NOT saved. */
  translation: string;
  /** false when the paragraph couldn't be translated (translation = input). */
  translated: boolean;
  sourceLang: LangCode;
  targetLang: LangCode;
  /**
   * Each word occurrence, in reading order, with its offsets in the paragraph
   * plus a best-effort `reading`/`lemma` (kuromoji for JA; null otherwise).
   * Readings here are DISPLAY annotations — statistical, not authoritative like
   * the verified `words` readings — so render them as a hint, not ground truth.
   */
  tokens: AnalyzedToken[];
  /** Lookup from a word's text to all its known meanings (verified first). */
  meanings: Map<string, Word[]>;
}

/**
 * Ask the dictionary which of kuromoji's adjacent-noun runs are actually ONE word,
 * and merge those. This is the I/O half of the compound fix; the span logic is
 * pure in language/compounds.ts.
 *
 * Probes are resolved cache-first and, for the rest, by a DICTIONARY-ONLY batch
 * call: a probe is a guess ("could 柔軟剤 be a word?") and most guesses miss, so
 * they must never reach the paid MT fallback — that would bill Google for wrong
 * guesses and cache their output as verified words. Confirmed probes are memoized,
 * so the merged compound is already cached when the main lookup runs and costs no
 * second round-trip.
 *
 * A failure here is NON-FATAL: the tokens come back unmerged, which is exactly
 * today's behaviour, so the reader degrades to fragments rather than breaking.
 *
 * OUTPUT: the token list, with confirmed compounds folded into single tokens.
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
          // Authoritative "no such entry" — this call never falls through to MT,
          // so the answer can't change this session. Remember it.
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
 * Translates a paragraph two ways, the way a reader actually uses it:
 *   - the WHOLE paragraph in context, for display only — NOT persisted (we will
 *     not store thousands of unique paragraphs), and
 *   - each distinct WORD individually with ALL its meanings, which ARE cached
 *     as verified words (context and dictionary senses can differ).
 *
 * Returns the word tokens (with positions) and a word -> meanings lookup; how
 * to render that (inline, dropdown, ...) is the frontend's call. Adds nothing
 * to the user's vocabulary; the user explicitly saves via userWords.saveDictionaryWord.
 *
 * OUTPUT: ParagraphTranslation { translation, translated, sourceLang,
 * targetLang, tokens, meanings: Map<token.text, Word[]> }.
 * CONSTRAINTS: paragraph translation is NEVER persisted (persist:false);
 * per-word seeding capped by MAX_TRANSLATION_CONCURRENCY; assumes one language
 * per paragraph.
 */
export async function translateParagraph(params: {
  input: string;
  targetLang: LangCode;
  sourceLang?: SourceSelection;
  /** Pre-computed analysis of `input`. When the caller already analyzed the text
   *  (e.g. submit's word-vs-sentence routing), pass it to skip a duplicate kuromoji
   *  tokenize of the same string. */
  tokens?: AnalyzedToken[];
  /** Fired the moment the whole-sentence gloss is ready — BEFORE the slower
   *  morphological analysis + per-word lookups — so the UI can show the
   *  translation immediately and stream the word-by-word reader in after. */
  onGloss?: (gloss: { translation: string; translated: boolean }) => void;
}): Promise<ParagraphTranslation> {
  const { targetLang, sourceLang = AUTO_DETECT } = params;
  const input = nfc(params.input);
  const resolvedSource = resolveSourceLanguage(input, sourceLang);

  // 1. Kick off the whole-paragraph gloss (display only, persist = false) WITHOUT
  //    awaiting: the colored reader below doesn't depend on it, so the gloss network
  //    call (the slowest piece — Google MT) runs CONCURRENTLY with analysis + the
  //    per-word lookups instead of in front of them. onGloss streams the translation
  //    the moment it lands; a gloss failure is non-fatal (reader still renders).
  const glossPromise = translate({ input, sourceLang: resolvedSource, targetLang, persist: false })
    .then((g) => {
      params.onGloss?.({ translation: g.translation ?? "", translated: g.translated });
      return g;
    })
    .catch(() => ({ translation: null as string | null, translated: false }));

  // 2. Tokens: reuse the caller's analysis when provided (submit already analyzed
  //    the text to route word-vs-sentence), else analyze here — avoids a duplicate
  //    kuromoji tokenize of the same string. Offsets stay pointed at the original
  //    paragraph; for JA this also yields per-token reading + lemma.
  let tokens = params.tokens ?? (await analyze(input, resolvedSource));

  // 2b. Re-merge compounds kuromoji over-segmented, validated against the
  //     DICTIONARY (柔軟 ＋ 剤 → 柔軟剤, which IS a JMdict entry). Without this the
  //     reader looks up the fragments and the word's meaning is simply lost —
  //     the top source of quality reports. The curated list in compounds.ts runs
  //     first (inside analyze) and covers what it covers; this generalizes it to
  //     every compound the dictionary actually has.
  if (resolvedSource.toUpperCase() === "JA") {
    tokens = await mergeDictionaryCompounds(tokens, resolvedSource, targetLang);
  }

  // 3. Look each word up by its LEMMA when known (so a conjugated form like
  //    行った resolves via its dictionary entry 行く), falling back to the
  //    surface text. The dictionary is keyed on dictionary forms, so this is the
  //    lookup key; results are re-exposed under the surface text below.
  const keyOf = (t: AnalyzedToken) => nfc(t.lemma ?? t.text);
  const uniqueKeys = [...new Set(tokens.map(keyOf))];

  // All meanings per key in ONE query (client cache + a single .in() read); any
  // word still uncached is resolved by ONE batched edge call below — so a long
  // paragraph costs one DB read + one edge round-trip, not hundreds.
  const meaningsByKey = await findWordTranslationsBatch({
    inputs: uniqueKeys,
    sourceLang: resolvedSource,
    targetLang,
  });
  const missing = uniqueKeys.filter((k) => !meaningsByKey.has(k));
  if (missing.length > 0) {
    // ONE batched edge call for every uncached word, instead of N per-word calls.
    // A failure here is non-fatal: those words just render uncolored (no meanings).
    try {
      const batch = await translateBatch({
        inputs: missing,
        sourceLang: resolvedSource,
        targetLang,
      });
      for (const key of missing) {
        const senses = batch.get(key) ?? [];
        if (senses.length > 0) {
          meaningsByKey.set(key, senses);
          setCachedSenses(key, resolvedSource, targetLang, senses); // memoize for repeats
        }
      }
    } catch {
      /* leave the uncached words without meanings */
    }
  }

  // 3b. Overlay the AUTHORITATIVE reading that already rides on the looked-up
  //     `words` senses (no extra table/query). Two guards keep it safe:
  //       (a) only when the surface IS the dictionary form (token.text === lemma):
  //           the stored reading is the HEADWORD's (行く→いく) and does NOT apply to
  //           a conjugated surface (行った reads いった, not いく) — keep kuromoji there.
  //       (b) only when the senses agree on a SINGLE reading (unambiguous); if
  //           JMdict lists several (辛い→からい/つらい), trust kuromoji's context guess.
  //     Otherwise kuromoji's reading stands. JA only.
  if (resolvedSource.toUpperCase() === "JA") {
    for (const token of tokens) {
      const isDictionaryForm = token.lemma === null || token.lemma === token.text;
      if (!isDictionaryForm) continue;
      const senses = meaningsByKey.get(keyOf(token)) ?? [];
      const distinct = [...new Set(senses.map((s) => s.inputReading).filter(Boolean))];
      if (distinct.length === 1) token.reading = distinct[0];
    }
  }

  // 4. Key by the ORIGINAL surface text so the frontend looks up with
  //    token.text directly; lemma resolution stays internal.
  const meanings = new Map<string, Word[]>();
  for (const token of tokens) {
    if (!meanings.has(token.text)) {
      meanings.set(token.text, meaningsByKey.get(keyOf(token)) ?? []);
    }
  }

  // Fold in the gloss — awaited here, but by this point it has usually resolved in
  // parallel with the analysis + lookups above (no longer in front of them).
  const para = await glossPromise;
  return {
    translation: para.translated ? para.translation ?? input : input,
    translated: para.translated,
    sourceLang: resolvedSource,
    targetLang,
    tokens,
    meanings,
  };
}
