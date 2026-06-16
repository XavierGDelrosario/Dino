// =========================================================
// Data access for the global `words` translation cache.
//
// Owns the words table and the DB-row <-> domain mapping. Nothing outside this
// file should read or write `words` directly.
// =========================================================

import { supabase } from "../../config/supabaseClient";
import type { LangCode } from "../language";

/** Domain representation of a cached translation (camelCase). */
export interface Word {
  wordId: string;
  input: string;
  translation: string;
  sourceLang: LangCode;
  targetLang: LangCode;
  isVerified: boolean;
  createdBy: string | null;
}

interface WordRow {
  word_id: string;
  input: string;
  translation: string;
  source_lang: string;
  target_lang: string;
  is_verified: boolean;
  created_by: string | null;
}

// NOTE: the `translate` edge function hand-mirrors this conflict tuple and the
// row -> Word mapping below (cross-runtime — keep the two in sync).
const WORD_UNIQUE_CONFLICT =
  "input,translation,source_lang,target_lang,created_by,is_verified";

function toWord(row: WordRow): Word {
  return {
    wordId: row.word_id,
    input: row.input,
    translation: row.translation,
    sourceLang: row.source_lang,
    targetLang: row.target_lang,
    isVerified: row.is_verified,
    createdBy: row.created_by,
  };
}

/**
 * Looks up an existing translation for a language pair. RLS scopes visibility
 * to verified (global) rows plus the caller's own unverified rows; verified
 * entries are preferred so the shared dictionary wins over a private guess.
 *
 * OUTPUT: the single preferred Word, or null.
 * CONSTRAINTS: inputs must be pre-normalized/concrete; verified-first ordering.
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
    .limit(1);

  if (error) throw error;

  return data?.[0] ? toWord(data[0]) : null;
}

/**
 * Inserts a new word the caller owns. Clients may only write unverified rows
 * (enforced by RLS); promotion to the verified global dictionary is a
 * privileged server-side operation. Idempotent on the unique tuple.
 *
 * OUTPUT: the persisted Word (is_verified = false).
 * CONSTRAINTS: always unverified; caller pre-normalizes input; idempotent on
 * the unique tuple.
 */
export async function insertUnverifiedWord(params: {
  input: string;
  translation: string;
  sourceLang: LangCode;
  targetLang: LangCode;
  createdBy: string;
}): Promise<Word> {
  const { input, translation, sourceLang, targetLang, createdBy } = params;

  const { data, error } = await supabase
    .from("words")
    .upsert(
      {
        input,
        translation,
        source_lang: sourceLang,
        target_lang: targetLang,
        is_verified: false,
        created_by: createdBy,
      },
      { onConflict: WORD_UNIQUE_CONFLICT }
    )
    .select<string, WordRow>("*")
    .single();

  if (error || !data) {
    throw error ?? new Error(`Failed to save word "${input}"`);
  }

  return toWord(data);
}

/**
 * Returns ALL known translations of a word for a language pair (verified +
 * the caller's own), verified first. A word can legitimately have several
 * meanings, so the single-word UI uses this to let the user pick which one to
 * save. `findCachedWord` returns only the single preferred entry.
 *
 * OUTPUT: Word[] — every meaning, verified first (may be empty).
 * CONSTRAINTS: inputs must be pre-normalized; RLS-scoped (verified + own).
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
    .order("is_verified", { ascending: false });

  if (error) throw error;
  return (data ?? []).map(toWord);
}

/**
 * Batched `findWordTranslations`: all meanings for many words in one query,
 * grouped by input word (verified first). Lets a caller map every word in a
 * paragraph to its meanings without N round-trips.
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
    .order("is_verified", { ascending: false });
  if (error) throw error;

  for (const row of data ?? []) {
    const word = toWord(row);
    const list = byWord.get(word.input) ?? [];
    list.push(word);
    byWord.set(word.input, list);
  }
  return byWord;
}
