// =========================================================
// A user's personal vocabulary (the `user_words` table) + sub-list tags
// (`list_words`).
//
// A `user_words` row is one word the user has. It either references a global
// dictionary sense (`dictionaryWordId`), OVERRIDES it (`customTranslation`),
// or STANDS ALONE (a created word: customTranslation set, no dictionaryWordId).
// The shown meaning is `customTranslation ?? dictionary.translation`.
//
// "ALL" is virtual: a user's vocabulary IS their `user_words` rows, so there is
// no ALL list to maintain. Sub-lists are optional tags in `list_words`; because
// a tag references a `user_words` row, deleting the row (deleteUserWord) removes
// the word from ALL and every sub-list at once (FK cascade). Removing a tag
// (removeUserWordFromList) just un-tags — the word stays in the vocabulary.
//
// Mastery/review state lives on the row, so a read returns it inline (no join).
// =========================================================

import { supabase } from "../../config/supabaseClient";
import { nfcTrim } from "../../lib/text";
import { mapLimit } from "../../lib/concurrency";
import { ServiceError, toServiceError } from "../errors";
import type { Database } from "../../types/database.types";
import type { LangCode } from "../language";
import type { Word } from "./repository";

/** A word in a user's personal vocabulary (camelCase domain shape). */
export interface UserWord {
  userWordId: string;
  userId: string;
  input: string;
  sourceLang: LangCode;
  targetLang: LangCode;
  /** Global sense this came from, or null for a standalone created word. */
  dictionaryWordId: string | null;
  /** The user's own meaning (created word or edit/override); null = use dictionary's. */
  customTranslation: string | null;
  /** Resolved meaning shown to the user: customTranslation ?? dictionary translation. */
  translation: string;
  /** Reading of the input side (from the dictionary sense), or null. */
  inputReading: string | null;
  /**
   * Reading of the resolved translation side, or null. Suppressed when the user
   * has overridden the meaning (`customTranslation` set) — the dictionary's
   * reading no longer annotates the user's own term.
   */
  translationReading: string | null;
  /**
   * Memory strength in days (the spaced-repetition forgetting-curve parameter);
   * null until first reviewed. Recall probability = exp(-Δdays / stability).
   * The review queue ranks on this via `retrievability()` (services/review.ts).
   */
  stability: number | null;
  /** Mastery: 0–5, 0 = new / never studied. Derived display bucket of `stability`. */
  confidenceRating: number;
  lastReviewedDate: string | null;
  originallyTranslatedDate: string;
}

// Flat columns derived from the generated schema types (so a schema change
// breaks toUserWord below), plus the OPTIONAL embedded dictionary row pulled via
// the FK (SELECT_WITH_DICTIONARY) — relations aren't part of a generated table
// Row, so it's composed on explicitly (its fields also derived from `words`).
type UserWordRow = Database["public"]["Tables"]["user_words"]["Row"] & {
  /** Embedded dictionary row when selected via the FK (reads only). */
  words?: Pick<
    Database["public"]["Tables"]["words"]["Row"],
    "translation" | "input_reading" | "translation_reading"
  > | null;
};

/** Embed string that pulls the referenced dictionary fields for resolution. */
const SELECT_WITH_DICTIONARY =
  "*, words(translation, input_reading, translation_reading)";

function toUserWord(row: UserWordRow): UserWord {
  return {
    userWordId: row.user_word_id,
    userId: row.user_id,
    input: row.input,
    sourceLang: row.source_lang,
    targetLang: row.target_lang,
    dictionaryWordId: row.dictionary_word_id,
    customTranslation: row.custom_translation,
    translation: row.custom_translation ?? row.words?.translation ?? "",
    // Input reading always comes from the dictionary sense (the input headword
    // is unchanged by a meaning override). The translation reading is suppressed
    // on override: the shown translation is then the user's own term, which the
    // dictionary reading does not annotate.
    inputReading: row.words?.input_reading ?? null,
    translationReading: row.custom_translation
      ? null
      : row.words?.translation_reading ?? null,
    stability: row.stability ?? null,
    confidenceRating: row.confidence_rating,
    lastReviewedDate: row.last_reviewed_date,
    originallyTranslatedDate: row.originally_translated_date,
  };
}

/** Tags a user_word into a sub-list (idempotent). */
async function tagInList(userWordId: string, listId: string): Promise<void> {
  const { error } = await supabase
    .from("list_words")
    .upsert(
      { list_id: listId, user_word_id: userWordId },
      { onConflict: "list_id,user_word_id" }
    );
  if (error) throw toServiceError(error);
}

/**
 * Saves a dictionary sense into the user's vocabulary (= adds it to ALL),
 * optionally tagging a sub-list. Idempotent per (user, dictionary sense): saving
 * the same sense twice is a no-op re-add, not a duplicate.
 *
 * OUTPUT: the UserWord (translation = the dictionary sense's translation).
 * CONSTRAINTS: `word` is a verified dictionary sense; custom_translation stays null.
 */
export async function saveDictionaryWord(params: {
  userId: string;
  word: Word;
  listId?: string;
  /** #10 cold-start seed (days of initial stability) for a NEW row; null/undefined
   *  = cold start. Ignored for an existing row (its real history is preserved). */
  initialStability?: number | null;
}): Promise<UserWord> {
  const { userId, word, listId, initialStability } = params;

  // One atomic RPC creates the entry AND tags the optional sub-list (see
  // save_dictionary_word in the init migration), so a failed tag can't leave the
  // word in ALL but not its chosen sub-list. input/langs are derived server-side
  // from the referenced sense.
  const { data, error } = await supabase.rpc("save_dictionary_word", {
    p_user_id: userId,
    p_dictionary_word_id: word.wordId,
    p_list_id: listId,
    p_initial_stability: initialStability ?? undefined,
  });
  if (error || !data) throw toServiceError(error, `Failed to save "${word.input}"`);

  // RETURNS user_words → a single row (PostgREST may wrap it in an array). The
  // row has no embedded dictionary; we already hold the sense, so patch its
  // translation and readings straight from the dictionary Word.
  const row = (Array.isArray(data) ? data[0] : data) as UserWordRow;
  return {
    ...toUserWord(row),
    translation: word.translation,
    inputReading: word.inputReading,
    translationReading: word.translationReading,
  };
}

/**
 * Saves MANY dictionary senses at once (the "Add all" path) in ONE round-trip /
 * ONE transaction, optionally tagging them all into a sub-list. Replaces N
 * separate saveDictionaryWord calls. Idempotent per (user, sense), like the
 * single save: re-saving is a no-op re-add.
 *
 * The batch is a SINGLE user gesture, so there is no client-side staging buffer
 * and therefore no "the session ended before my saves flushed" data-loss window —
 * the user clicks once, the write happens once, all-or-nothing.
 *
 * OUTPUT: UserWord[] — one per saved sense (order not guaranteed; map by id).
 * CONSTRAINTS: each id must be a verified dictionary sense; an unknown/unverified
 * id is silently skipped (one bad id can't fail the whole batch).
 */
export async function saveDictionaryWords(params: {
  userId: string;
  words: Word[];
  listId?: string;
  /** #10 cold-start seed per word (days of initial stability; null = cold). Applied
   *  only to NEW rows, aligned to the de-duped word list. */
  seedFor?: (word: Word) => number | null;
}): Promise<UserWord[]> {
  const { userId, words, listId, seedFor } = params;
  if (words.length === 0) return [];

  // Dedupe by wordId KEEPING the Word, so a per-id seed stays aligned to the ids.
  const unique = [...new Map(words.map((w) => [w.wordId, w])).values()];
  const ids = unique.map((w) => w.wordId);
  const { data, error } = await supabase.rpc("save_dictionary_words", {
    p_user_id: userId,
    p_dictionary_word_ids: ids,
    p_list_id: listId,
    p_initial_stabilities: seedFor ? unique.map((w) => seedFor(w)) : undefined,
  });
  if (error) throw toServiceError(error, "Failed to save words");

  // RETURNS SETOF user_words (no embedded dictionary). Patch each row's
  // translation/readings from the in-hand Word it came from, keyed by sense id.
  const byId = new Map(words.map((w) => [w.wordId, w]));
  return ((data ?? []) as UserWordRow[]).map((row) => {
    const uw = toUserWord(row);
    const w = row.dictionary_word_id ? byId.get(row.dictionary_word_id) : undefined;
    return w
      ? { ...uw, translation: w.translation, inputReading: w.inputReading, translationReading: w.translationReading }
      : uw;
  });
}

/**
 * Creates a user's OWN word (no dictionary sense behind it), optionally tagging
 * a sub-list. NFC-normalizes; both the word and its meaning are required.
 *
 * OUTPUT: the standalone UserWord (translation = the supplied meaning).
 * CONSTRAINTS: input AND translation required; dictionary_word_id is null.
 */
export async function createCustomWord(params: {
  userId: string;
  input: string;
  translation: string;
  sourceLang: LangCode;
  targetLang: LangCode;
  listId?: string;
}): Promise<UserWord> {
  const { userId, sourceLang, targetLang, listId } = params;
  const input = nfcTrim(params.input);
  const translation = nfcTrim(params.translation);
  if (!input || !translation) {
    throw new ServiceError("Both the word and its meaning are required", "validation");
  }

  // One atomic RPC creates the standalone word AND tags the optional sub-list
  // (see create_custom_word in the init migration), so a failed tag can't leave
  // the word in ALL but not its chosen sub-list. The idempotent re-create — the
  // PARTIAL-unique violation that ON CONFLICT can't target (Postgres 42P10) — is
  // caught and re-fetched inside the function. NFC normalization stays here (the
  // input boundary); the RPC receives already-normalized values.
  const { data, error } = await supabase.rpc("create_custom_word", {
    p_user_id: userId,
    p_input: input,
    p_translation: translation,
    p_source: sourceLang,
    p_target: targetLang,
    p_list_id: listId,
  });
  if (error || !data) throw toServiceError(error, `Failed to create "${input}"`);

  // RETURNS user_words → a single row (PostgREST may wrap it in an array).
  const row = (Array.isArray(data) ? data[0] : data) as UserWordRow;
  return toUserWord(row);
}

/**
 * Edits a word's meaning IN PLACE by setting an override on the SAME entry — no
 * new row, so it never duplicates in ALL. Works for any user_word (a saved
 * dictionary sense becomes an override; a created word changes its meaning).
 *
 * OUTPUT: the updated UserWord (translation = the new meaning).
 * CONSTRAINTS: translation required (NFC-normalized); the dictionary row is untouched.
 */
export async function editUserWord(params: {
  userWordId: string;
  translation: string;
}): Promise<UserWord> {
  const translation = nfcTrim(params.translation);
  if (!translation) throw new ServiceError("A meaning is required", "validation");

  const { data, error } = await supabase
    .from("user_words")
    .update({ custom_translation: translation })
    .eq("user_word_id", params.userWordId)
    .select<string, UserWordRow>(SELECT_WITH_DICTIONARY)
    .single();
  if (error || !data) throw toServiceError(error, "Failed to edit word");
  return toUserWord(data);
}

/**
 * Deletes a word from the user's vocabulary: removes it from ALL and EVERY
 * sub-list (list_words cascades). Re-adding later starts fresh at confidence 0.
 *
 * OUTPUT: void.
 * CONSTRAINTS: the global dictionary row is never touched.
 */
export async function deleteUserWord(params: { userWordId: string }): Promise<void> {
  const { error } = await supabase
    .from("user_words")
    .delete()
    .eq("user_word_id", params.userWordId);
  if (error) throw toServiceError(error);
}

/** Tags an existing user_word into a sub-list. */
export async function addUserWordToList(params: {
  listId: string;
  userWordId: string;
}): Promise<void> {
  await tagInList(params.userWordId, params.listId);
}

/**
 * Un-tags a word from a sub-list (drops only the list_words row). The word
 * stays in the user's vocabulary (still in ALL).
 *
 * OUTPUT: void.
 */
export async function removeUserWordFromList(params: {
  listId: string;
  userWordId: string;
}): Promise<void> {
  const { error } = await supabase
    .from("list_words")
    .delete()
    .eq("list_id", params.listId)
    .eq("user_word_id", params.userWordId);
  if (error) throw toServiceError(error);
}

/** Default page size for the vocabulary reads (load-more pagination). A power
 *  user's list is unbounded, so reads are paged rather than pulling every row. */
export const USER_WORDS_PAGE_SIZE = 100;

/**
 * One PAGE of the user's whole vocabulary (= the virtual ALL list), newest first,
 * each with its resolved meaning and mastery. Order has a `user_word_id` tiebreaker
 * so ranges are stable across calls (originally_translated_date isn't unique).
 *
 * OUTPUT: UserWord[] (≤ limit; may be empty). A full page implies more may exist.
 * CONSTRAINTS: RLS-scoped to the caller's own rows.
 */
export async function getAllUserWords(params: {
  userId: string;
  limit?: number;
  offset?: number;
}): Promise<UserWord[]> {
  const limit = params.limit ?? USER_WORDS_PAGE_SIZE;
  const offset = params.offset ?? 0;
  const { data, error } = await supabase
    .from("user_words")
    .select<string, UserWordRow>(SELECT_WITH_DICTIONARY)
    .eq("user_id", params.userId)
    .order("originally_translated_date", { ascending: false })
    .order("user_word_id", { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) throw toServiceError(error);
  return (data ?? []).map(toUserWord);
}

/**
 * One PAGE of the words tagged into a sub-list, each with resolved meaning and
 * mastery. Ordered by `user_word_id` for stable ranges.
 *
 * OUTPUT: UserWord[] (≤ limit; may be empty). A full page implies more may exist.
 * CONSTRAINTS: RLS-scoped via the parent list.
 */
export async function getUserWordsInList(params: {
  listId: string;
  limit?: number;
  offset?: number;
}): Promise<UserWord[]> {
  const limit = params.limit ?? USER_WORDS_PAGE_SIZE;
  const offset = params.offset ?? 0;
  const { data, error } = await supabase
    .from("list_words")
    .select<string, { user_words: UserWordRow | null }>(
      `user_word_id, user_words(${SELECT_WITH_DICTIONARY})`
    )
    .eq("list_id", params.listId)
    .order("user_word_id", { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) throw toServiceError(error);

  return (data ?? [])
    .map((r) => r.user_words)
    .filter((w): w is UserWordRow => w !== null)
    .map(toUserWord);
}

export interface UserWordState {
  /** true if the user has saved this dictionary sense. */
  tracked: boolean;
  userWordId: string | null;
  /** confidence 0–5. 0 = new (not saved, or saved but never studied). */
  confidenceRating: number;
  lastReviewedDate: string | null;
}

/**
 * Per-user state for a set of DICTIONARY senses (e.g. the meanings in a
 * translated paragraph): whether the user has saved each, plus mastery. The
 * returned Map has an entry for every requested id; ids the user hasn't saved
 * come back `tracked: false`, `confidenceRating: 0`.
 *
 * OUTPUT: Map<dictionaryWordId, UserWordState>.
 * CONSTRAINTS: RLS-scoped to the caller's own rows.
 */
// Max ids per `.in()` GET. A UUID is ~39 URL-encoded chars (36 + `%2C`), so 100
// keeps a single query URL near ~4 KB — well under typical server/proxy limits.
const ID_CHUNK_SIZE = 100;
// A long EN→JA paragraph can produce many chunks; cap in-flight requests.
const ID_CHUNK_CONCURRENCY = 6;

export async function getUserWordStates(params: {
  userId: string;
  dictionaryWordIds: string[];
}): Promise<Map<string, UserWordState>> {
  const { userId } = params;
  const uniqueIds = [...new Set(params.dictionaryWordIds)];

  const states = new Map<string, UserWordState>(
    uniqueIds.map((id) => [
      id,
      { tracked: false, userWordId: null, confidenceRating: 0, lastReviewedDate: null },
    ])
  );
  if (uniqueIds.length === 0) return states;

  // CHUNK the `.in()` filter. The id set is unbounded — a single EN→JA paragraph
  // word can carry HUNDREDS of senses (JMdict reverse-matches the English token in
  // every Japanese gloss: "the" → 400+), so a whole paragraph yields thousands of
  // ids. Inlining them all makes a PostgREST GET URL that exceeds the server limit
  // (414 URI Too Long → the fetch throws → the reader never renders). One bounded
  // GET per ID_CHUNK_SIZE ids keeps every URL small; results merge into `states`.
  const chunks: string[][] = [];
  for (let i = 0; i < uniqueIds.length; i += ID_CHUNK_SIZE) {
    chunks.push(uniqueIds.slice(i, i + ID_CHUNK_SIZE));
  }

  const rowsPerChunk = await mapLimit(chunks, ID_CHUNK_CONCURRENCY, async (ids) => {
    const { data, error } = await supabase
      .from("user_words")
      .select<string, UserWordRow>(
        "user_word_id, dictionary_word_id, confidence_rating, last_reviewed_date"
      )
      .eq("user_id", userId)
      .in("dictionary_word_id", ids);
    if (error) throw toServiceError(error);
    return data ?? [];
  });

  for (const rows of rowsPerChunk) {
    for (const r of rows) {
      if (!r.dictionary_word_id) continue;
      states.set(r.dictionary_word_id, {
        tracked: true,
        userWordId: r.user_word_id,
        confidenceRating: r.confidence_rating,
        lastReviewedDate: r.last_reviewed_date,
      });
    }
  }
  return states;
}
