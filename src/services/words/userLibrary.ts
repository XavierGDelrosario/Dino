// =========================================================
// A user's personal word library: list membership + mastery state.
//
// Owns list_words and user_word_mastery for the "save a word" operation.
// Every saved word always lands in the user's ALL list; an optional target
// list adds a second membership.
//
// TODO (post-POC, review item #2): saveWordToUserLibrary does three sequential
// writes (snapshot read -> mastery upsert -> list_words upsert) that are NOT in
// one transaction, and the "every saved word is in ALL" invariant is enforced
// here in app code rather than by the DB. Move this into a single transactional
// Postgres RPC (e.g. add_word_to_list) so the writes are atomic and the
// invariant can't be bypassed by a direct client call. Low risk for the POC:
// writes are ordered to minimize damage and each is an idempotent upsert, so a
// partial failure self-heals on the next save.
// =========================================================

import { supabase } from "../../config/supabaseClient";
import { getOrCreateAllListId } from "../lists";

interface ListWordRow {
  list_id: string;
  word_id: string;
}

/**
 * Ensures `wordId` is linked to the user's ALL list (and an optional target
 * list) and that a mastery row exists with the schema default confidence.
 *
 * @returns isNewForUser — true if this is the first time the word entered the
 *          user's ALL list (i.e. a genuinely new save, not a re-add).
 */
export async function saveWordToUserLibrary(params: {
  userId: string;
  wordId: string;
  listId?: string;
}): Promise<{ isNewForUser: boolean }> {
  const { userId, wordId, listId } = params;
  const allListId = await getOrCreateAllListId(userId);

  // Snapshot ALL-list membership BEFORE inserting to compute isNewForUser.
  const { data: before, error: beforeError } = await supabase
    .from("list_words")
    .select<string, ListWordRow>("list_id, word_id")
    .eq("list_id", allListId)
    .eq("word_id", wordId);

  if (beforeError) throw beforeError;

  const isNewForUser = (before?.length ?? 0) === 0;

  // Ensure a mastery row exists (confidence_rating defaults to 1 in schema).
  const { error: masteryError } = await supabase
    .from("user_word_mastery")
    .upsert({ user_id: userId, word_id: wordId }, { onConflict: "user_id,word_id" });

  if (masteryError) throw masteryError;

  // Always link into ALL; also link into the target list when provided.
  const rows: ListWordRow[] = [{ list_id: allListId, word_id: wordId }];
  if (listId && listId !== allListId) {
    rows.push({ list_id: listId, word_id: wordId });
  }

  const { error: linkError } = await supabase
    .from("list_words")
    .upsert(rows, { onConflict: "list_id,word_id" });

  if (linkError) throw linkError;

  return { isNewForUser };
}

/**
 * Removes a single word from one list (drops only the list_words link).
 *
 * The word row and the user's mastery are left untouched — global dictionary
 * data and the user's "universal brain" survive, matching the POC's cascade
 * rules. Used by the edit path to detach the word being replaced.
 */
export async function removeWordFromList(params: {
  listId: string;
  wordId: string;
}): Promise<void> {
  const { listId, wordId } = params;

  const { error } = await supabase
    .from("list_words")
    .delete()
    .eq("list_id", listId)
    .eq("word_id", wordId);

  if (error) throw error;
}
