// =========================================================
// DINO lookup / read-only translation.
//
// Translate for DISPLAY and surface meanings WITHOUT saving to the user's
// lists. `lookupWord` returns every meaning of a word; `translateParagraph`
// returns a whole-paragraph contextual translation (NOT persisted) plus a
// word -> meanings lookup. Saving a chosen word is a separate, explicit step
// (saveWordToUserLibrary). Translation is delegated to the backend.
// =========================================================

import {
  resolveSourceLanguage,
  tokenizeWords,
  AUTO_DETECT,
  type LangCode,
  type SourceSelection,
  type WordToken,
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
 * Read-only with respect to the user's lists: this never adds anything to a
 * list. Saving a chosen meaning is a separate, explicit step
 * (saveWordToUserLibrary). It may populate the global word cache.
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
  /** Each word occurrence, in reading order, with its offsets in the paragraph. */
  tokens: WordToken[];
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
 * to the user's lists; the user explicitly saves words via saveWordToUserLibrary.
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

  // 2. Segment into words. Token offsets stay pointed at the original
  //    paragraph (for display); their TEXT is NFC-normalized for cache keys.
  const tokens = tokenizeWords(input, resolvedSource);
  const uniqueWords = [...new Set(tokens.map((t) => t.text.normalize("NFC")))];

  // 3. All meanings per word in one query; for any uncached word, ask its
  //    language pair's sense provider (real dictionary → all senses; MT
  //    fallback → one). Bounded fan-out so a long paragraph doesn't fire
  //    hundreds of requests at once.
  const meaningsByWord = await findWordTranslationsBatch({
    inputs: uniqueWords,
    sourceLang: resolvedSource,
    targetLang,
  });
  const senseProvider = resolveSenseProvider(resolvedSource, targetLang);
  const missing = uniqueWords.filter((w) => !meaningsByWord.has(w));
  await mapLimit(missing, MAX_TRANSLATION_CONCURRENCY, async (word) => {
    const senses = await senseProvider(word, resolvedSource, targetLang);
    if (senses.length > 0) meaningsByWord.set(word, senses);
  });

  // 4. Re-key by the ORIGINAL token text so the frontend looks up with
  //    token.text directly; NFC normalization stays internal.
  const meanings = new Map<string, Word[]>();
  for (const token of tokens) {
    if (!meanings.has(token.text)) {
      meanings.set(
        token.text,
        meaningsByWord.get(token.text.normalize("NFC")) ?? []
      );
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
