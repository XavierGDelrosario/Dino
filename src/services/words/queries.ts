// =========================================================
// Read queries over a user's saved words.
//
// Read-only and RLS-scoped: list_words/words are joined for display, then each
// word is enriched with the caller's mastery (confidence + review dates). The
// write paths live in repository.ts / userLibrary.ts / customWords.ts.
// =========================================================

import { supabase } from "../../config/supabaseClient";
import type { Word } from "./repository";

export interface ListWordEntry {
  word: Word;
  /** Caller's confidence 0-5 (0 = new / never studied). */
  confidenceRating: number;
  lastReviewedDate: string | null;
  nextReviewDate: string | null;
}

interface JoinedRow {
  word_id: string;
  words: {
    word_id: string;
    input: string;
    translation: string;
    source_lang: string;
    target_lang: string;
    is_verified: boolean;
    created_by: string | null;
  } | null;
}

interface MasteryRow {
  word_id: string;
  confidence_rating: number;
  last_reviewed_date: string | null;
  next_review_date: string | null;
}

/**
 * Returns the words in a list joined with the user's mastery for each.
 * Two scoped reads (words via the junction, then mastery) merged in memory —
 * avoids a cross-table join the client can't express cleanly under RLS.
 *
 * OUTPUT: ListWordEntry[] — Word + mastery (confidenceRating 0 = new/never studied).
 * CONSTRAINTS: RLS-scoped; mastery merged in memory, not a DB join.
 */
export async function getListWords(params: {
  userId: string;
  listId: string;
}): Promise<ListWordEntry[]> {
  const { userId, listId } = params;

  const { data: rows, error } = await supabase
    .from("list_words")
    .select<string, JoinedRow>(
      "word_id, words(word_id, input, translation, source_lang, target_lang, is_verified, created_by)"
    )
    .eq("list_id", listId);
  if (error) throw error;

  const words: Word[] = (rows ?? [])
    .map((r) => r.words)
    .filter((w): w is NonNullable<JoinedRow["words"]> => w !== null)
    .map((w) => ({
      wordId: w.word_id,
      input: w.input,
      translation: w.translation,
      sourceLang: w.source_lang,
      targetLang: w.target_lang,
      isVerified: w.is_verified,
      createdBy: w.created_by,
    }));

  if (words.length === 0) return [];

  const wordIds = words.map((w) => w.wordId);
  const { data: mastery, error: masteryError } = await supabase
    .from("user_word_mastery")
    .select<string, MasteryRow>(
      "word_id, confidence_rating, last_reviewed_date, next_review_date"
    )
    .eq("user_id", userId)
    .in("word_id", wordIds);
  if (masteryError) throw masteryError;

  const masteryByWord = new Map<string, MasteryRow>(
    (mastery ?? []).map((m) => [m.word_id, m])
  );

  return words.map((word) => {
    const m = masteryByWord.get(word.wordId);
    return {
      word,
      confidenceRating: m?.confidence_rating ?? 0,
      lastReviewedDate: m?.last_reviewed_date ?? null,
      nextReviewDate: m?.next_review_date ?? null,
    };
  });
}

export interface UserWordState {
  /** true if a mastery row exists — the user has saved/engaged this word. */
  tracked: boolean;
  /** confidence 0-5. 0 = new (no row, or saved but never studied). */
  confidenceRating: number;
  lastReviewedDate: string | null;
  nextReviewDate: string | null;
}

/**
 * Per-user mastery state for an ARBITRARY set of words (e.g. the words/meanings
 * in a translated paragraph), keyed by wordId — not tied to any list, unlike
 * getListWords. Each meaning is its own wordId, so this gives per-meaning
 * confidence. The returned Map has an entry for every requested id; ids with no
 * mastery row come back `tracked: false`, `confidenceRating: 0` (i.e. new).
 *
 * OUTPUT: Map<wordId, UserWordState> — one entry per requested wordId.
 * CONSTRAINTS: RLS-scoped to the caller's own mastery rows; user-specific.
 */
export async function getUserWordStates(params: {
  userId: string;
  wordIds: string[];
}): Promise<Map<string, UserWordState>> {
  const { userId, wordIds } = params;
  const uniqueIds = [...new Set(wordIds)];

  // Default every requested id to "new / not tracked".
  const states = new Map<string, UserWordState>(
    uniqueIds.map((id) => [
      id,
      {
        tracked: false,
        confidenceRating: 0,
        lastReviewedDate: null,
        nextReviewDate: null,
      },
    ])
  );
  if (uniqueIds.length === 0) return states;

  const { data, error } = await supabase
    .from("user_word_mastery")
    .select<string, MasteryRow>(
      "word_id, confidence_rating, last_reviewed_date, next_review_date"
    )
    .eq("user_id", userId)
    .in("word_id", uniqueIds);
  if (error) throw error;

  for (const m of data ?? []) {
    states.set(m.word_id, {
      tracked: true,
      confidenceRating: m.confidence_rating,
      lastReviewedDate: m.last_reviewed_date,
      nextReviewDate: m.next_review_date,
    });
  }
  return states;
}
