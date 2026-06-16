// =========================================================
// DINO add-to-list flow (translate + save) — "quick add".
//
// Translates a word (or many) and immediately saves it to the user's list,
// accepting the PREFERRED cached meaning. This is the deliberate "just add it"
// path. For a review-first flow that surfaces ALL meanings before saving, see
// lookup.ts (read-only) plus an explicit saveWordToUserLibrary.
//
// Implements the POC "Find or Create" look-up rule (see DinoPOC.md). The
// translation API call itself is SERVER-ONLY: this runs in the browser and
// can only ask the `translate` Edge Function to translate + cache a verified
// word. The browser never holds the provider's API key and cannot translate
// on its own. (Provider — DeepL/Google/other — is not yet decided for the POC.)
//
// Client-side here (safe under RLS): resolving the source language, reading the
// cache, and linking words into the user's own lists/mastery.
//
// Flow: resolve source -> check cache -> ask backend to translate on miss. If
// the backend returns no result we just show the input (like Google Translate)
// and persist nothing. Users save their own meaning via the custom-word path
// (words/customWords.ts), not here.
// =========================================================

import {
  resolveSourceLanguage,
  AUTO_DETECT,
  type LangCode,
  type SourceSelection,
} from "./language";
import { findCachedWord, type Word } from "./words/repository";
import { saveWordToUserLibrary } from "./words/userLibrary";
import { translate, MAX_TRANSLATION_CONCURRENCY } from "./translation";
import { mapLimit } from "../lib/concurrency";

export interface AddWordResult {
  input: string;
  /** The translation, or the input text itself when translation was unavailable. */
  translation: string;
  sourceLang: LangCode;
  targetLang: LangCode;
  /** false when the provider had no result and we are just showing the input. */
  translated: boolean;
  /** false when nothing was persisted (failed translations are not cached). */
  saved: boolean;
  /** true if served from the cache (no API call). Only meaningful when saved. */
  fromCache: boolean;
  /** true if this is the first time the word entered the user's ALL list. */
  isNewForUser: boolean;
  /** The persisted word; present only when `saved` is true. */
  word?: Word;
}

/**
 * Runs the Find-or-Create translate-and-save flow for a single word, accepting
 * the preferred cached meaning. (Use lookup.ts to review all meanings first.)
 *
 * @param targetLang UI-selected target language (always explicit)
 * @param sourceLang UI source selection; defaults to "Detect language"
 *
 * OUTPUT: AddWordResult (translated, saved, fromCache, isNewForUser, word?).
 * CONSTRAINTS: NFC-normalizes input; throws on empty input or source == target;
 * failed translations are NOT saved (shows the input instead).
 */
export async function addWordToList(params: {
  userId: string;
  input: string;
  targetLang: LangCode;
  sourceLang?: SourceSelection;
  listId?: string;
}): Promise<AddWordResult> {
  const { userId, targetLang, sourceLang = AUTO_DETECT, listId } = params;

  // NFC-normalize so visually identical inputs (composed vs decomposed,
  // full/half-width) share one cache key — important for Japanese.
  const input = params.input.trim().normalize("NFC");
  if (!input) {
    throw new Error("Cannot add an empty word");
  }

  const resolvedSource = resolveSourceLanguage(input, sourceLang);
  if (resolvedSource === targetLang) {
    throw new Error(
      `Source and target language are both "${targetLang}"; nothing to translate`
    );
  }

  // --- Steps 1-2: cache check (client read, allowed by RLS) --------------
  const cached = await findCachedWord({
    input,
    sourceLang: resolvedSource,
    targetLang,
  });
  if (cached) {
    const { isNewForUser } = await saveWordToUserLibrary({
      userId,
      wordId: cached.wordId,
      listId,
    });
    return {
      input,
      translation: cached.translation,
      sourceLang: resolvedSource,
      targetLang,
      translated: true,
      saved: true,
      fromCache: true,
      isNewForUser,
      word: cached,
    };
  }

  // --- Step 3: ask the server to translate (+ cache as a verified word) --
  const { translated, word } = await translate({
    input,
    sourceLang: resolvedSource,
    targetLang,
  });

  // No result: show the input, don't persist (avoid poisoning the cache).
  if (!translated || !word) {
    return {
      input,
      translation: input,
      sourceLang: resolvedSource,
      targetLang,
      translated: false,
      saved: false,
      fromCache: false,
      isNewForUser: false,
    };
  }

  // --- Step 5: link the backend-created word into the user's library -----
  const { isNewForUser } = await saveWordToUserLibrary({
    userId,
    wordId: word.wordId,
    listId,
  });

  return {
    input,
    translation: word.translation,
    sourceLang: resolvedSource,
    targetLang,
    translated: true,
    saved: true,
    fromCache: false,
    isNewForUser,
    word,
  };
}

/**
 * Translates many words with bounded concurrency and returns one result per
 * DISTINCT word, in first-occurrence order.
 *
 * Inputs are trimmed and de-duplicated so each distinct word is translated
 * once (no duplicate API bills) and its `isNewForUser` stays correct — running
 * the same word twice in parallel would otherwise both snapshot "not saved yet"
 * and both report new. Partition the result by `isNewForUser` for new-vs-seen.
 *
 * OUTPUT: AddWordResult[] — one per DISTINCT word, first-occurrence order.
 * CONSTRAINTS: de-dupes (NFC-normalized); capped at MAX_TRANSLATION_CONCURRENCY.
 */
export async function addWordsToList(params: {
  userId: string;
  inputs: string[];
  targetLang: LangCode;
  sourceLang?: SourceSelection;
  listId?: string;
}): Promise<AddWordResult[]> {
  const { userId, inputs, targetLang, sourceLang, listId } = params;

  const seen = new Set<string>();
  const unique: string[] = [];
  for (const raw of inputs) {
    const input = raw.trim().normalize("NFC");
    if (input && !seen.has(input)) {
      seen.add(input);
      unique.push(input);
    }
  }

  return mapLimit(unique, MAX_TRANSLATION_CONCURRENCY, (input) =>
    addWordToList({ userId, input, targetLang, sourceLang, listId })
  );
}
