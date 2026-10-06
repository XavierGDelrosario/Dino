// A user's personal vocabulary (`user_words`) + sub-list tags (`list_words`).
//
// A row either references a global dictionary sense (`dictionaryWordId`), OVERRIDES it
// (`customTranslation`), or STANDS ALONE (a created word). Shown meaning is
// `customTranslation ?? dictionary.translation`.
//
// "ALL" is virtual — the vocabulary IS these rows, so there is no ALL list to maintain.
// Sub-lists are optional tags; since a tag references a `user_words` row, deleting the
// row removes the word from ALL and every sub-list at once (FK cascade), while removing
// a tag just un-tags. Mastery/review state lives on the row, so reads return it inline.

import { supabase } from "../../config/supabaseClient";
import { notifyStudyActivity } from "../studyActivity";
import { nfcTrim } from "../../lib/text";
import { mapLimit } from "../../lib/concurrency";
import { chunkForUrlFilter } from "../../lib/urlFilter";
import { ServiceError, toServiceError } from "../errors";
import { displayConfidence, type ConfidenceInputs } from "../confidence";
import * as vocabulary from "./vocabularyCache";
import type { Database } from "../../types/database.types";
import type { LangCode } from "../language";
import type { Word } from "./repository";
import { isSyntheticWordId } from "./syntheticId";

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
  /** Reading of the resolved translation side. Suppressed on override — the shown
   *  term is then the user's own, which the dictionary reading doesn't annotate. */
  translationReading: string | null;
  /** Memory strength in days; null until first reviewed. R = exp(-Δdays / stability). */
  stability: number | null;
  /** Mastery 0–5, 0 = new / never studied. */
  confidenceRating: number;
  lastReviewedDate: string | null;
  originallyTranslatedDate: string;
  /** Read-only attributes joined from the referenced `words` sense (null for a
   *  standalone created word). Feed the word-info panel; never stored here. */
  proficiencyBand: number | null;
  partOfSpeech: string[] | null;
  frequency: number | null;
  /** Stored level estimate when there's no curated band (20260779). Optional: the review
   *  queue's rows don't carry it, and a database without the column degrades to null. */
  estimatedBand?: number | null;
  /** A sentence demonstrating the SAVED SENSE, its gloss, a monolingual definition,
   *  and pinned furigana for the target inside `example`. Null when unwritten. */
  example: string | null;
  exampleGloss: string | null;
  definitionSource: string | null;
  exampleReading: string | null;
  /** The raw inputs `confidenceRating` was derived from, so a CACHED word can re-derive
   *  it later (it decays with time) — see vocabularyCache.wordsFor. */
  confidenceInputs?: ConfidenceInputs;
}

// Flat columns from the generated schema types (so a schema change breaks toUserWord),
// plus the embedded dictionary row — relations aren't part of a generated table Row, so
// it's composed on explicitly.
type UserWordRow = Database["public"]["Tables"]["user_words"]["Row"] & {
  /** Embedded dictionary row when selected via the FK (reads only). */
  words?: Pick<
    Database["public"]["Tables"]["words"]["Row"],
    | "translation"
    | "input_reading"
    | "translation_reading"
    | "proficiency_band"
    | "part_of_speech"
    | "frequency"
    | "estimated_band"
    | "example"
    | "example_gloss"
    | "definition_source"
    | "example_reading"
  > | null;
};

// ‼️ AVAILABILITY: naming a column in an embedded select makes the WHOLE read depend on
// the database having taken a migration — PostgREST answers with 42703 and fails the
// ENTIRE query, so a client ahead of its database loses the vocabulary, not one field.
// (Observed: an iOS build pointed at prod 42703'd every Lists read.)
//
// So columns a migration ADDED are OPTIONAL: asked for first, dropped for the rest of
// the session the moment the database says it lacks them. The mapping reads them with
// `?? null`, so an un-migrated database degrades to "no example written yet".
const DICTIONARY_COLUMNS =
  "translation, input_reading, translation_reading, proficiency_band, part_of_speech, frequency";
/** Added by 20260750 (the example columns) and 20260779 (estimated_band). Absent on any
 *  database that hasn't taken them. */
const DICTIONARY_COLUMNS_OPTIONAL = "example, example_gloss, definition_source, example_reading, estimated_band";

/** Latched false by the first 42703; a reload re-probes, so applying the migration
 *  heals the client with no redeploy. */
let optionalColumnsAvailable = true;

/** The dictionary fields to embed, minus anything this database has told us it lacks. */
function dictionaryColumns(): string {
  return optionalColumnsAvailable
    ? `${DICTIONARY_COLUMNS}, ${DICTIONARY_COLUMNS_OPTIONAL}`
    : DICTIONARY_COLUMNS;
}

/** TEST SEAM (mirrors repository.ts's __clearWordsCache): the latch above is
 *  module-global, so without a reset one spec's downgrade leaks into the next. */
export function __resetDictionaryColumnProbe(): void {
  optionalColumnsAvailable = true;
}

/** PostgREST's "undefined column" — the whole query fails, not just the column. */
const isMissingColumn = (error: { code?: string } | null): boolean => error?.code === "42703";

/**
 * Run a dictionary-embedding read, retrying ONCE without the optional columns if this
 * database lacks them. `run` builds its own query from the column list, because the
 * three call sites embed at different depths.
 */
async function readWithDictionary<T>(
  run: (columns: string) => PromiseLike<{ data: T | null; error: { code?: string } | null }>,
): Promise<T | null> {
  let res = await run(dictionaryColumns());
  if (isMissingColumn(res.error) && optionalColumnsAvailable) {
    // Latch, so one probe costs one extra round-trip per session rather than per read.
    optionalColumnsAvailable = false;
    console.warn(
      "[userWords] this database predates migration 20260750; " +
        "continuing without per-sense examples.",
    );
    res = await run(dictionaryColumns());
  }
  if (res.error) throw toServiceError(res.error);
  return res.data;
}

/**
 * The LIVE 0–5 confidence from a raw row — decayed with time and carrying the
 * short-term strength a study session earned (services/confidence.ts, mirroring
 * migration 20260735) — NOT the stored `confidence_rating` snapshot. Every read surface
 * goes through here so they all show the number the review queue does. */
/** The raw columns the display confidence is derived from. */
type ConfidenceRow = {
  stability?: number | null;
  last_reviewed_date: string | null;
  originally_translated_date: string;
  short_stability?: number | null;
  short_stability_at?: string | null;
  peak_confidence?: number | null;
};

export function confidenceInputsOf(row: ConfidenceRow): ConfidenceInputs {
  return {
    stability: row.stability ?? null,
    lastReviewedDate: row.last_reviewed_date,
    originallyTranslatedDate: row.originally_translated_date,
    shortStability: row.short_stability ?? null,
    shortStabilityAt: row.short_stability_at ?? null,
    peakConfidence: row.peak_confidence ?? null,
  };
}

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
    // The input headword is unchanged by a meaning override, so its reading always
    // comes from the sense; the translation reading is suppressed on override.
    inputReading: row.words?.input_reading ?? null,
    translationReading: row.custom_translation
      ? null
      : row.words?.translation_reading ?? null,
    stability: row.stability ?? null,
    // LIVE, not row.confidence_rating — that snapshot is frozen at the last review and
    // would disagree with the review queue's server-side computation.
    confidenceRating: displayConfidence(confidenceInputsOf(row)),
    confidenceInputs: confidenceInputsOf(row),
    lastReviewedDate: row.last_reviewed_date,
    originallyTranslatedDate: row.originally_translated_date,
    proficiencyBand: row.words?.proficiency_band ?? null,
    partOfSpeech: row.words?.part_of_speech ?? null,
    frequency: row.words?.frequency ?? null,
    estimatedBand: row.words?.estimated_band ?? null,
    // Sense enrichment (20260750). NOT suppressed by a custom_translation: an override
    // renames the MEANING, while the example still demonstrates the saved sense.
    example: row.words?.example ?? null,
    exampleGloss: row.words?.example_gloss ?? null,
    definitionSource: row.words?.definition_source ?? null,
    exampleReading: row.words?.example_reading ?? null,
  };
}

/** The ONE `list_words` write: an idempotent upsert of N tags. Every tag path goes
 *  through here, so the conflict target (the idempotency contract) is stated once. */
async function tagInList(userWordIds: string[], listId: string): Promise<void> {
  if (userWordIds.length === 0) return;
  const { error } = await supabase.from("list_words").upsert(
    userWordIds.map((userWordId) => ({ list_id: listId, user_word_id: userWordId })),
    { onConflict: "list_id,user_word_id" }
  );
  if (error) throw toServiceError(error);
  vocabulary.retagInCache("tag", listId, userWordIds);
}

/**
 * Saves a dictionary sense into the user's vocabulary (= adds it to ALL), optionally
 * tagging a sub-list. Idempotent per (user, sense): re-saving is a no-op re-add.
 */
export async function saveDictionaryWord(params: {
  userId: string;
  word: Word;
  listId?: string;
  /** Cold-start seed (days of initial stability) for a NEW row. Ignored for an
   *  existing row, whose real history is preserved. */
  initialStability?: number | null;
}): Promise<UserWord> {
  const { userId, word, listId, initialStability } = params;

  // One atomic RPC creates the entry AND tags the sub-list, so a failed tag can't
  // leave the word in ALL but not its chosen list. input/langs derive server-side.
  const { data, error } = await supabase.rpc("save_dictionary_word", {
    p_user_id: userId,
    p_dictionary_word_id: word.wordId,
    p_list_id: listId,
    p_initial_stability: initialStability ?? undefined,
  });
  if (error || !data) throw toServiceError(error, `Failed to save "${word.input}"`);

  // A single row (PostgREST may wrap it in an array), with no embedded dictionary —
  // we already hold the sense, so patch translation/readings from the Word.
  const row = (Array.isArray(data) ? data[0] : data) as UserWordRow;
  const saved: UserWord = {
    ...toUserWord(row),
    translation: word.translation,
    inputReading: word.inputReading,
    translationReading: word.translationReading,
    proficiencyBand: word.proficiencyBand,
    partOfSpeech: word.partOfSpeech,
    frequency: word.frequency,
    estimatedBand: word.estimatedBand,
  };
  vocabulary.writeWords(userId, [saved], listId);
  notifyStudyActivity();
  return saved;
}

/**
 * Saves MANY senses ("Add all") in ONE round-trip / ONE transaction, optionally tagging
 * them into a sub-list. Idempotent per (user, sense) like the single save. Order is not
 * guaranteed — map by id. An unknown or unverified id is silently skipped, so one bad
 * id can't fail the batch.
 */
export async function saveDictionaryWords(params: {
  userId: string;
  words: Word[];
  listId?: string;
  /** Cold-start seed per word (days; null = cold). NEW rows only. */
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

  // No embedded dictionary — patch each row from the in-hand Word, keyed by sense id.
  const byId = new Map(words.map((w) => [w.wordId, w]));
  const saved = ((data ?? []) as UserWordRow[]).map((row) => {
    const uw = toUserWord(row);
    const w = row.dictionary_word_id ? byId.get(row.dictionary_word_id) : undefined;
    return w
      ? {
          ...uw,
          translation: w.translation,
          inputReading: w.inputReading,
          translationReading: w.translationReading,
          proficiencyBand: w.proficiencyBand,
          partOfSpeech: w.partOfSpeech,
          frequency: w.frequency,
          estimatedBand: w.estimatedBand,
        }
      : uw;
  });
  vocabulary.writeWords(userId, saved, listId);
  notifyStudyActivity();
  return saved;
}

/** Creates a user's OWN word (no dictionary sense behind it), optionally tagging a
 *  sub-list. Both the word and its meaning are required. */
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

  // One atomic RPC creates the word AND tags the sub-list, so a failed tag can't leave
  // the word in ALL but not its chosen list. The idempotent re-create (a PARTIAL-unique
  // violation ON CONFLICT can't target, Postgres 42P10) is caught inside the function.
  const { data, error } = await supabase.rpc("create_custom_word", {
    p_user_id: userId,
    p_input: input,
    p_translation: translation,
    p_source: sourceLang,
    p_target: targetLang,
    p_list_id: listId,
  });
  if (error || !data) throw toServiceError(error, `Failed to create "${input}"`);

  const row = (Array.isArray(data) ? data[0] : data) as UserWordRow;
  const created = toUserWord(row);
  vocabulary.writeWords(userId, [created], listId);
  notifyStudyActivity();
  return created;
}

/**
 * Edits a meaning IN PLACE by setting an override on the SAME entry — no new row, so it
 * never duplicates in ALL. Works for any user_word; the dictionary row is untouched.
 */
export async function editUserWord(params: {
  userWordId: string;
  translation: string;
}): Promise<UserWord> {
  const translation = nfcTrim(params.translation);
  if (!translation) throw new ServiceError("A meaning is required", "validation");

  const data = await readWithDictionary<UserWordRow>((columns) =>
    supabase
      .from("user_words")
      .update({ custom_translation: translation })
      .eq("user_word_id", params.userWordId)
      .select<string, UserWordRow>(`*, words(${columns})`)
      .single(),
  ).catch((e) => {
    throw toServiceError(e, "Failed to edit word");
  });
  if (!data) throw new ServiceError("Failed to edit word");
  const edited = toUserWord(data);
  vocabulary.writeWordById(edited.userWordId, edited);
  return edited;
}

/**
 * Drop the user's own meaning and go back to the DICTIONARY's — the undo of
 * `editUserWord`. Only for a word that came from the dictionary: a word the user
 * created has no original to go back to (and the `user_words_has_meaning` check
 * refuses a row with neither meaning).
 */
export async function revertUserWord(params: { userWordId: string }): Promise<UserWord> {
  const data = await readWithDictionary<UserWordRow>((columns) =>
    supabase
      .from("user_words")
      .update({ custom_translation: null })
      .eq("user_word_id", params.userWordId)
      .not("dictionary_word_id", "is", null)
      .select<string, UserWordRow>(`*, words(${columns})`)
      .single(),
  ).catch((e) => {
    throw toServiceError(e, "Failed to revert word");
  });
  if (!data) throw new ServiceError("Failed to revert word");
  const reverted = toUserWord(data);
  vocabulary.writeWordById(reverted.userWordId, reverted);
  return reverted;
}

/** Has the user replaced this dictionary word's meaning with their own? (A word they
 *  CREATED also has a custom meaning, but it is the only one — nothing was replaced.) */
export function isMeaningEdited(w: Pick<UserWord, "customTranslation" | "dictionaryWordId">): boolean {
  return w.customTranslation != null && w.dictionaryWordId != null;
}

/**
 * Deletes a word from the vocabulary: removes it from ALL and EVERY sub-list
 * (list_words cascades). Re-adding later starts fresh at confidence 0. The global
 * dictionary row is never touched.
 */
export async function deleteUserWord(params: { userWordId: string }): Promise<void> {
  const { error } = await supabase
    .from("user_words")
    .delete()
    .eq("user_word_id", params.userWordId);
  if (error) throw toServiceError(error);
  vocabulary.removeWord(params.userWordId);
}

// A select-all on a big vocabulary is thousands of ids; cap in-flight statements.
const BULK_WRITE_CONCURRENCY = 4;

/**
 * Deletes MANY words from the vocabulary (the Lists multi-select). Same semantics as
 * deleteUserWord per word. The ids ride in the URL of a DELETE, so they are chunked
 * (lib/urlFilter) — which makes this several statements, NOT one transaction: if a
 * chunk fails, the earlier ones stay deleted. The cache is written through per
 * committed chunk, so the table shows exactly what is gone and the caller can retry
 * the remainder.
 */
export async function deleteUserWords(params: { userWordIds: string[] }): Promise<void> {
  const chunks = chunkForUrlFilter([...new Set(params.userWordIds)]);
  await mapLimit(chunks, BULK_WRITE_CONCURRENCY, async (ids) => {
    const { error } = await supabase.from("user_words").delete().in("user_word_id", ids);
    if (error) throw toServiceError(error);
    vocabulary.removeWords(ids);
  });
}

/** Tags an existing user_word into a sub-list. */
export async function addUserWordToList(params: {
  listId: string;
  userWordId: string;
}): Promise<void> {
  await tagInList([params.userWordId], params.listId);
}

/**
 * Tags MANY user_words into one sub-list in a single round trip. Same idempotent upsert
 * as the single-word tag, so words already in the list are a no-op. RLS gates BOTH sides
 * of the tag, so a foreign id fails the whole statement rather than tagging part of it.
 */
export async function addUserWordsToList(params: {
  listId: string;
  userWordIds: string[];
}): Promise<void> {
  await tagInList(params.userWordIds, params.listId);
}

/** Un-tags a word from a sub-list. The word stays in the vocabulary (still in ALL). */
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
  vocabulary.retagInCache("untag", params.listId, [params.userWordId]);
}

/**
 * Un-tags MANY words from one sub-list; they all stay in the vocabulary. Chunked like
 * deleteUserWords, with the same per-chunk write-through. Every statement carries the
 * list_id filter — by user_word_id alone it would strip the words from EVERY list.
 */
export async function removeUserWordsFromList(params: {
  listId: string;
  userWordIds: string[];
}): Promise<void> {
  const chunks = chunkForUrlFilter([...new Set(params.userWordIds)]);
  await mapLimit(chunks, BULK_WRITE_CONCURRENCY, async (ids) => {
    const { error } = await supabase
      .from("list_words")
      .delete()
      .eq("list_id", params.listId)
      .in("user_word_id", ids);
    if (error) throw toServiceError(error);
    vocabulary.retagInCache("untag", params.listId, ids);
  });
}

/** Page size for vocabulary reads — a power user's list is unbounded, so reads are
 *  paged rather than pulling every row. This is the FIRST page (it paints the table);
 *  the rest of a full load comes in USER_WORDS_BULK_PAGE_SIZE pages. */
export const USER_WORDS_PAGE_SIZE = 100;

/** The pages AFTER the first in a full vocabulary load. 1000 = PostgREST's default
 *  max-rows, so a larger ask would silently come back short and end the load early. */
export const USER_WORDS_BULK_PAGE_SIZE = 1000;

/**
 * Every (list, word) tag the user has — which is what lets the vocabulary cache show
 * any list as a FILTER over ALL instead of a request per list. Small (one row per tag),
 * paged at the max-rows cap. RLS-scoped to the caller's own lists.
 */
export async function getListMembership(): Promise<Array<{ listId: string; userWordId: string }>> {
  const out: Array<{ listId: string; userWordId: string }> = [];
  for (let offset = 0; ; offset += USER_WORDS_BULK_PAGE_SIZE) {
    const { data, error } = await supabase
      .from("list_words")
      .select("list_id, user_word_id")
      .order("list_id")
      .order("user_word_id")
      .range(offset, offset + USER_WORDS_BULK_PAGE_SIZE - 1);
    if (error) throw toServiceError(error);
    for (const r of data ?? []) out.push({ listId: r.list_id, userWordId: r.user_word_id });
    if ((data ?? []).length < USER_WORDS_BULK_PAGE_SIZE) return out;
  }
}

/**
 * One PAGE of the whole vocabulary (= the virtual ALL list), newest first, with resolved
 * meaning and mastery. The `user_word_id` tiebreaker keeps ranges stable across calls,
 * since originally_translated_date isn't unique. A full page implies more may exist.
 */
export async function getAllUserWords(params: {
  userId: string;
  limit?: number;
  offset?: number;
}): Promise<UserWord[]> {
  const limit = params.limit ?? USER_WORDS_PAGE_SIZE;
  const offset = params.offset ?? 0;
  const data = await readWithDictionary<UserWordRow[]>((columns) =>
    supabase
      .from("user_words")
      .select<string, UserWordRow>(`*, words(${columns})`)
      .eq("user_id", params.userId)
      .order("originally_translated_date", { ascending: false })
      .order("user_word_id", { ascending: false })
      .range(offset, offset + limit - 1),
  );
  return (data ?? []).map(toUserWord);
}

export interface UserWordState {
  /** true if the user has saved this dictionary sense. */
  tracked: boolean;
  userWordId: string | null;
  /** confidence 0–5. 0 = new (not saved, or saved but never studied). */
  confidenceRating: number;
  lastReviewedDate: string | null;
}

// A long EN→JA paragraph can produce many chunks; cap in-flight requests.
const ID_CHUNK_CONCURRENCY = 6;

/**
 * Per-user state for a set of DICTIONARY senses: saved or not, plus mastery. The map
 * has an entry for EVERY requested id — unsaved ones come back tracked:false, 0.
 */

export async function getUserWordStates(params: {
  userId: string;
  dictionaryWordIds: string[];
}): Promise<Map<string, UserWordState>> {
  const { userId } = params;
  const allIds = [...new Set(params.dictionaryWordIds)];

  const states = new Map<string, UserWordState>(
    allIds.map((id) => [
      id,
      { tracked: false, userWordId: null, confidenceRating: 0, lastReviewedDate: null },
    ])
  );
  // Only real dictionary ids go to the database. A reader can also hold a NAME's
  // stand-in sense (lookup.ts `nameSense`, id "name:…"), which has no row to find — and
  // one non-uuid in the filter makes Postgres reject the whole read (22P02), which
  // would leave every word on the page looking unsaved.
  const uniqueIds = allIds.filter((id) => !isSyntheticWordId(id));
  if (uniqueIds.length === 0) return states;

  // CHUNK the `.in()` filter: the id set is unbounded (one EN→JA word can carry
  // hundreds of senses, so a paragraph yields thousands of ids) and inlining them all
  // builds a URL past the server limit — 414, the fetch throws, the reader never
  // renders. Budgeted by encoded bytes; see lib/urlFilter.
  const chunks = chunkForUrlFilter(uniqueIds);

  const rowsPerChunk = await mapLimit(chunks, ID_CHUNK_CONCURRENCY, async (ids) => {
    const { data, error } = await supabase
      .from("user_words")
      .select<string, UserWordRow>(
        // The last four feed displayConfidence: the reader's ✓ n/5 must be the same
        // live number Lists shows, not the row snapshot.
        "user_word_id, dictionary_word_id, confidence_rating, last_reviewed_date, " +
          "stability, originally_translated_date, short_stability, short_stability_at, peak_confidence"
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
        confidenceRating: displayConfidence(confidenceInputsOf(r)),
        lastReviewedDate: r.last_reviewed_date,
      });
    }
  }
  return states;
}
