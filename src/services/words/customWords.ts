// =========================================================
// Manual word entry: the lists-menu "add your own word / edit" button.
//
// Distinct from the translate flow (dictionary.ts): here the user supplies
// both the word and its meaning. We upsert their word and point the list at
// it. Editing is the same operation plus detaching the word being replaced —
// "upsert the new one and change the list-word relationship".
// =========================================================

import type { LangCode } from "../language";
import { insertUnverifiedWord, type Word } from "./repository";
import { saveWordToUserLibrary, removeWordFromList } from "./userLibrary";

/**
 * Adds a user's own word to a list, or edits an existing list entry.
 *
 * Always upserts the (unverified) word and links it into the list + ALL with a
 * mastery row. When `replacesWordId` is given (an edit), the old word is
 * detached from `listId` afterwards — its word row stays in the global cache
 * and in any other lists / the user's mastery history.
 *
 * @param replacesWordId word currently in `listId` being corrected (edit only)
 *
 * OUTPUT: { word, isNewForUser }.
 * CONSTRAINTS: input AND translation required (both NFC-normalized); word saved
 * is_verified = false; replacesWordId detaches only from `listId`.
 */
export async function saveCustomWord(params: {
  userId: string;
  input: string;
  translation: string;
  sourceLang: LangCode;
  targetLang: LangCode;
  listId?: string;
  replacesWordId?: string;
}): Promise<{ word: Word; isNewForUser: boolean }> {
  const { userId, sourceLang, targetLang, listId, replacesWordId } = params;

    // NFC-normalize so cache keys are canonical (matches dictionary.ts). Characters may look identical but are different.
    const input = params.input.trim().normalize("NFC");
    const translation = params.translation.trim().normalize("NFC");
    if (!input || !translation) {
      throw new Error("Both the word and its meaning are required");
    }

  const word = await insertUnverifiedWord({
    input,
    translation,
    sourceLang,
    targetLang,
    createdBy: userId,
  });

  const { isNewForUser } = await saveWordToUserLibrary({
    userId,
    wordId: word.wordId,
    listId,
  });

  // Edit: detach the word being replaced from this list.
  if (replacesWordId && listId && replacesWordId !== word.wordId) {
    await removeWordFromList({ listId, wordId: replacesWordId });
  }

  return { word, isNewForUser };
}
