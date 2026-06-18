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
  findWordTranslations,
  findWordTranslationsBatch,
  type Word,
} from "./words/repository";
import { translate, MAX_TRANSLATION_CONCURRENCY } from "./translation";
import { resolveSenseProvider } from "./senses";
import { mapLimit } from "../lib/concurrency";

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
  const input = params.input.trim().normalize("NFC");
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
  }

  return { input, sourceLang: resolvedSource, targetLang, meanings };
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
}): Promise<ParagraphTranslation> {
  const { targetLang, sourceLang = AUTO_DETECT } = params;
  const input = params.input.normalize("NFC");
  const resolvedSource = resolveSourceLanguage(input, sourceLang);

  // 1. Whole-paragraph contextual translation — display only, persist = false.
  const para = await translate({
    input,
    sourceLang: resolvedSource,
    targetLang,
    persist: false,
  });

  // 2. Morphologically analyze into tokens. Offsets stay pointed at the original
  //    paragraph (for display); for JA this also yields per-token reading + lemma.
  const tokens = await analyze(input, resolvedSource);

  // 3. Look each word up by its LEMMA when known (so a conjugated form like
  //    行った resolves via its dictionary entry 行く), falling back to the
  //    surface text. The dictionary is keyed on dictionary forms, so this is the
  //    lookup key; results are re-exposed under the surface text below.
  const keyOf = (t: AnalyzedToken) => (t.lemma ?? t.text).normalize("NFC");
  const uniqueKeys = [...new Set(tokens.map(keyOf))];

  // All meanings per key in one query; for any uncached word, ask its language
  // pair's sense provider (real dictionary → all senses; MT fallback → one).
  // Bounded fan-out so a long paragraph doesn't fire hundreds of requests.
  const meaningsByKey = await findWordTranslationsBatch({
    inputs: uniqueKeys,
    sourceLang: resolvedSource,
    targetLang,
  });
  const senseProvider = resolveSenseProvider(resolvedSource, targetLang);
  const missing = uniqueKeys.filter((k) => !meaningsByKey.has(k));
  await mapLimit(missing, MAX_TRANSLATION_CONCURRENCY, async (key) => {
    // One word's lookup failing must NOT break the whole paragraph — it just
    // renders uncolored (no meanings). A paragraph fans out many per-word calls.
    try {
      const senses = await senseProvider(key, resolvedSource, targetLang);
      if (senses.length > 0) meaningsByKey.set(key, senses);
    } catch {
      /* leave this word without meanings */
    }
  });

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

  return {
    translation: para.translated ? para.translation ?? input : input,
    translated: para.translated,
    sourceLang: resolvedSource,
    targetLang,
    tokens,
    meanings,
  };
}
