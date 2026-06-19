// =========================================================
// Read access to the global `words` dictionary cache.
//
// `words` is the SHARED dictionary: verified, system-owned senses. It is
// READ-ONLY to clients (RLS: SELECT verified rows only) — the `translate` edge
// function is the only writer. User-authored content (created words, edits)
// lives in `user_words` (see userWords.ts), never here.
//
// This file owns the DB-row <-> domain `Word` mapping; nothing else reads `words`.
// =========================================================

import { supabase } from "../../config/supabaseClient";
import type { LangCode } from "../language";

/** Domain representation of a dictionary sense (camelCase). */
export interface Word {
  wordId: string;
  input: string;
  translation: string;
  sourceLang: LangCode;
  targetLang: LangCode;
  /** Reading of the input side (kana/pinyin/…), or null if it needs none. */
  inputReading: string | null;
  /** Reading of the translation side, or null if it needs none. */
  translationReading: string | null;
  /**
   * STABLE JMdict source identity (null for non-JMdict rows). The sense this row
   * was projected from, INDEPENDENT of the mutable headword — what `user_words`
   * effectively pins to (via word_id) and what a cache re-projection keys on. See
   * the #1/#5 deferred items in CLAUDE.md.
   */
  jmdictEntryId: string | null;
  /** JA→EN: the entry's sense index (0 = primary); EN→JA: match rank. Null = non-JMdict. */
  jmdictSensePos: number | null;
  isVerified: boolean;
}

interface WordRow {
  word_id: string;
  input: string;
  translation: string;
  source_lang: string;
  target_lang: string;
  input_reading: string | null;
  translation_reading: string | null;
  jmdict_entry_id: string | null;
  jmdict_sense_pos: number | null;
  is_verified: boolean;
}

function toWord(row: WordRow): Word {
  return {
    wordId: row.word_id,
    input: row.input,
    translation: row.translation,
    sourceLang: row.source_lang,
    targetLang: row.target_lang,
    inputReading: row.input_reading ?? null,
    translationReading: row.translation_reading ?? null,
    jmdictEntryId: row.jmdict_entry_id ?? null,
    jmdictSensePos: row.jmdict_sense_pos ?? null,
    isVerified: row.is_verified,
  };
}

/**
 * The single preferred dictionary sense for a language pair (verified-first),
 * or null. RLS scopes visibility to verified rows.
 *
 * OUTPUT: the single preferred Word, or null.
 * CONSTRAINTS: inputs must be pre-normalized/concrete.
 */
export async function findCachedWord(params: {
  input: string;
  sourceLang: LangCode;
  targetLang: LangCode;
}): Promise<Word | null> {
  const { input, sourceLang, targetLang } = params;

  const { data, error } = await supabase
    .from("words")
    .select<string, WordRow>("*")
    .eq("input", input)
    .eq("source_lang", sourceLang)
    .eq("target_lang", targetLang)
    .order("is_verified", { ascending: false })
    .order("jmdict_sense_pos", { ascending: true, nullsFirst: false })
    .limit(1);

  if (error) throw error;

  return data?.[0] ? toWord(data[0]) : null;
}

/**
 * ALL known dictionary senses of a word for a language pair (verified-first).
 * A word can legitimately have several meanings; the single-word UI uses this
 * to show them all. `findCachedWord` returns only the preferred one.
 *
 * OUTPUT: Word[] — every sense (may be empty).
 * CONSTRAINTS: inputs must be pre-normalized; RLS-scoped (verified).
 */
export async function findWordTranslations(params: {
  input: string;
  sourceLang: LangCode;
  targetLang: LangCode;
}): Promise<Word[]> {
  const { input, sourceLang, targetLang } = params;

  const { data, error } = await supabase
    .from("words")
    .select<string, WordRow>("*")
    .eq("input", input)
    .eq("source_lang", sourceLang)
    .eq("target_lang", targetLang)
    .order("is_verified", { ascending: false })
    .order("jmdict_sense_pos", { ascending: true, nullsFirst: false });

  if (error) throw error;
  return (data ?? []).map(toWord);
}

/**
 * Batched `findWordTranslations`: all senses for many words in one query,
 * grouped by input word (verified-first). Lets a caller map every word in a
 * paragraph to its senses without N round-trips.
 *
 * OUTPUT: Map<input, Word[]> keyed by the stored input string.
 * CONSTRAINTS: query with the same normalization used when words were stored.
 */
export async function findWordTranslationsBatch(params: {
  inputs: string[];
  sourceLang: LangCode;
  targetLang: LangCode;
}): Promise<Map<string, Word[]>> {
  const { inputs, sourceLang, targetLang } = params;
  const unique = [...new Set(inputs)];
  const byWord = new Map<string, Word[]>();
  if (unique.length === 0) return byWord;

  const { data, error } = await supabase
    .from("words")
    .select<string, WordRow>("*")
    .in("input", unique)
    .eq("source_lang", sourceLang)
    .eq("target_lang", targetLang)
    .order("is_verified", { ascending: false })
    .order("jmdict_sense_pos", { ascending: true, nullsFirst: false });
  if (error) throw error;

  for (const row of data ?? []) {
    const word = toWord(row);
    const list = byWord.get(word.input) ?? [];
    list.push(word);
    byWord.set(word.input, list);
  }
  return byWord;
}
