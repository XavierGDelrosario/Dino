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
import { nfc } from "../../lib/text";
import { toServiceError } from "../errors";
import { FRESH } from "../../lib/projection";
import { chunkForUrlFilter } from "../../lib/urlFilter";
import { mapLimit } from "../../lib/concurrency";
import { getCachedSenses, setCachedSenses } from "./cache";
import type { Database } from "../../types/database.types";
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
  /** POS tags of the sense (JMdict codes: n, v5k, …); null for non-JMdict rows. */
  partOfSpeech: string[] | null;
  /**
   * DIFFICULTY AXIS. Corpus-frequency RANK (lower = more common; null = unranked).
   * Resolved to a level by services/difficulty (getDifficulty). Distinct from the
   * relatedness axis (future word_embeddings), never conflated.
   */
  frequency: number | null;
  /** Normalized 1..5 curated difficulty (JLPT/HSK); overrides frequency. null today. */
  difficultyOverride: number | null;
  /**
   * PROFICIENCY LABEL axis (curated, per-language: JLPT for JA, CEFR for EN …).
   * Raw framework band, ascending = HARDER; resolved to a display label ("N3",
   * "B2") by services/proficiency (the framework is derived from sourceLang).
   * Null when the word has no curated band (the common case until a wordlist is
   * ingested). SEPARATE from the frequency difficulty axis above — never conflate.
   */
  proficiencyBand: number | null;
  /**
   * STABLE JMdict source identity (null for non-JMdict rows). The sense this row
   * was projected from, INDEPENDENT of the mutable headword — what `user_words`
   * effectively pins to (via word_id) and what a cache re-projection keys on. See
   * the #1/#5 deferred items in CLAUDE.md.
   */
  jmdictEntryId: string | null;
  /** JA→EN: the entry's sense index (0 = primary); EN→JA: match rank. Null = non-JMdict. */
  jmdictSensePos: number | null;
  /**
   * SENSE ENRICHMENT (authored corpus, migration 20260750) — all three null until a
   * sense has been written, which is most of them.
   *
   * A Japanese sentence demonstrating THIS sense specifically. The point is what a
   * gloss list structurally cannot do: 辛い "spicy" and 辛い "painful" read identically
   * as English, but one sentence each settles them. JA→EN rows only — for EN→JA
   * `jmdictSensePos` is a match rank, not a sense index, so nothing can be keyed on it.
   */
  example: string | null;
  /** English translation of `example`. Null when the example has no gloss yet. */
  exampleGloss: string | null;
  /**
   * A monolingual Japanese definition of THIS sense, written as a JA dictionary writes
   * one (deliberately not simplified). Carries usage an English gloss cannot — 遜色
   * glossed "inferiority" invites the unnatural 遜色がある; the definition records
   * 多くは「ない」を伴って使う.
   */
  definitionSource: string | null;
  /**
   * How the target reads inside `example` — set only where kuromoji reads it wrong and
   * no rewrite fixes it (辛い→つらい, 金→きん/きむ). Overrules the analyzer for the
   * example's furigana; null means kuromoji is trusted, as everywhere else.
   */
  exampleReading: string | null;
  isVerified: boolean;
}

// The `words` table row, derived from the generated schema types so a
// renamed/removed column becomes a COMPILE error in toWord() below. (The query
// `.select("*")` returns extra columns toWord ignores — dictionary_ref etc.)
type WordRow = Database["public"]["Tables"]["words"]["Row"];

// ‼️ AVAILABILITY: `sense_rank` (migration 20260751) is the column every cache read
// SORTS by, and PostgREST rejects an ORDER BY on a column the database doesn't have —
// 42703, failing the whole query, exactly as a missing SELECT column does. A client
// running ahead of its migration would therefore lose dictionary lookups entirely.
// Same treatment as the dictionary embed in userWords.ts: ask for the curated order,
// and on 42703 fall back to jmdict_sense_pos, which is what sense_rank is seeded to
// anyway — so the fallback is not a degraded order, it is the identical one minus any
// hand-curated overrides.
let curatedOrderAvailable = true;

/** The column cache reads sort senses by. */
const orderColumn = (): "sense_rank" | "jmdict_sense_pos" =>
  curatedOrderAvailable ? "sense_rank" : "jmdict_sense_pos";

/** TEST SEAM — the latch is module-global (mirrors __clearWordsCache). */
export function __resetCuratedOrderProbe(): void {
  curatedOrderAvailable = true;
}

const isMissingColumn = (error: { code?: string } | null): boolean => error?.code === "42703";

/**
 * Run a senses query, retrying once on the pre-curation ordering if this database
 * predates 20260751. `run` takes the order column and builds its own query.
 */
async function readOrdered<T>(
  run: (order: "sense_rank" | "jmdict_sense_pos") => PromiseLike<{ data: T | null; error: { code?: string } | null }>,
): Promise<{ data: T | null; error: { code?: string } | null }> {
  const res = await run(orderColumn());
  if (isMissingColumn(res.error) && curatedOrderAvailable) {
    curatedOrderAvailable = false;
    console.warn("[repository] database predates migration 20260751; using JMdict sense order.");
    return run(orderColumn());
  }
  return res;
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
    partOfSpeech: row.part_of_speech ?? null,
    frequency: row.frequency ?? null,
    difficultyOverride: row.difficulty_override ?? null,
    proficiencyBand: row.proficiency_band ?? null,
    jmdictEntryId: row.jmdict_entry_id ?? null,
    jmdictSensePos: row.jmdict_sense_pos ?? null,
    example: row.example ?? null,
    exampleGloss: row.example_gloss ?? null,
    definitionSource: row.definition_source ?? null,
    exampleReading: row.example_reading ?? null,
    isVerified: row.is_verified,
  };
}

/**
 * The single preferred dictionary sense for a language pair (verified-first),
 * or null. RLS scopes visibility to verified rows.
 *
 * OUTPUT: the single preferred Word, or null.
 * CONSTRAINTS: source/target must be concrete; input is NFC-normalized here so
 * the cache key + DB query always match what the edge stored.
 */
export async function findCachedWord(params: {
  input: string;
  sourceLang: LangCode;
  targetLang: LangCode;
}): Promise<Word | null> {
  const { sourceLang, targetLang } = params;
  const input = nfc(params.input);

  // Read-through: if the full sense list is memoized, the preferred sense is its
  // first element (same verified-first order) — no round-trip. A miss keeps the
  // cheaper limit(1) query and does NOT populate the senses cache (one row is an
  // incomplete sense list; only findWordTranslations caches the complete set).
  const cached = getCachedSenses(input, sourceLang, targetLang);
  if (cached) return cached[0] ?? null;

  const { data, error } = await readOrdered<WordRow[]>((orderCol) => supabase
    .from("words")
    .select<string, WordRow>("*")
    .eq("input", input)
    .eq("source_lang", sourceLang)
    .eq("target_lang", targetLang)
    // Skip rows projected by OLDER logic — a stale hit here would short-circuit the
    // edge and serve the pre-fix projection forever. Treating them as a miss sends the
    // word to the edge, which re-projects it in place. MT rows are gated too: the edge
    // re-checks the dictionary for free and only falls back on the paid text it already
    // has (see src/lib/projection.ts).
    .or(FRESH)
    .order("is_verified", { ascending: false })
    .order(orderCol, { ascending: true, nullsFirst: false })
    .limit(1));

  if (error) throw toServiceError(error);

  return data?.[0] ? toWord(data[0]) : null;
}

/**
 * ALL known dictionary senses of a word for a language pair (verified-first).
 * A word can legitimately have several meanings; the single-word UI uses this
 * to show them all. `findCachedWord` returns only the preferred one.
 *
 * OUTPUT: Word[] — every sense (may be empty).
 * CONSTRAINTS: input is NFC-normalized here (matching the stored rows); RLS-scoped (verified).
 */
export async function findWordTranslations(params: {
  input: string;
  sourceLang: LangCode;
  targetLang: LangCode;
}): Promise<Word[]> {
  const { sourceLang, targetLang } = params;
  const input = nfc(params.input);

  const cached = getCachedSenses(input, sourceLang, targetLang);
  if (cached) return cached;

  const { data, error } = await readOrdered<WordRow[]>((orderCol) => supabase
    .from("words")
    .select<string, WordRow>("*")
    .eq("input", input)
    .eq("source_lang", sourceLang)
    .eq("target_lang", targetLang)
    .or(FRESH) // stale projections are a MISS (see findCachedWord)
    .order("is_verified", { ascending: false })
    .order(orderCol, { ascending: true, nullsFirst: false }));

  if (error) throw toServiceError(error);
  const words = (data ?? []).map(toWord);
  setCachedSenses(input, sourceLang, targetLang, words); // no-op when empty
  return words;
}

/**
 * Batched `findWordTranslations`: all senses for many words in one query,
 * grouped by input word (verified-first). Lets a caller map every word in a
 * paragraph to its senses without N round-trips.
 *
 * OUTPUT: Map<input, Word[]> keyed by the stored input string.
 * CONSTRAINTS: inputs are NFC-normalized here (matching the stored rows).
 */
/** Cap in-flight chunk queries so a long paste can't open a request per chunk. */
const URL_FILTER_CONCURRENCY = 6;

export async function findWordTranslationsBatch(params: {
  inputs: string[];
  sourceLang: LangCode;
  targetLang: LangCode;
}): Promise<Map<string, Word[]>> {
  const { sourceLang, targetLang } = params;
  const unique = [...new Set(params.inputs.map(nfc))];
  const byWord = new Map<string, Word[]>();
  if (unique.length === 0) return byWord;

  // Serve memoized inputs from the cache; query only the misses.
  const misses: string[] = [];
  for (const input of unique) {
    const cached = getCachedSenses(input, sourceLang, targetLang);
    if (cached) byWord.set(input, cached);
    else misses.push(input);
  }
  if (misses.length === 0) return byWord;

  // CHUNK the `.in()` filter by encoded size. Inlining every term makes a GET URL
  // that a long paste can push past the request limit — the whole query then fails
  // and the caller sees NO meanings for ANY word (quality report #3; see
  // lib/urlFilter.ts). Each term lands in exactly one chunk, so the per-input
  // ordering the grouping below relies on is preserved within its own query.
  const chunks = chunkForUrlFilter(misses);
  const rowsPerChunk = await mapLimit(chunks, URL_FILTER_CONCURRENCY, async (inputs) => {
    const { data, error } = await readOrdered<WordRow[]>((orderCol) => supabase
      .from("words")
      .select<string, WordRow>("*")
      .in("input", inputs)
      .eq("source_lang", sourceLang)
      .eq("target_lang", targetLang)
      .or(FRESH) // stale projections are a MISS (see findCachedWord)
      .order("is_verified", { ascending: false })
      .order(orderCol, { ascending: true, nullsFirst: false }));
    if (error) throw toServiceError(error);
    return data ?? [];
  });

  // Group the fetched rows by their stored headword (= the query input for these
  // dictionary-form lookups), then memoize each non-empty group for next time.
  const fetched = new Map<string, Word[]>();
  for (const row of rowsPerChunk.flat()) {
    const word = toWord(row);
    const list = fetched.get(word.input) ?? [];
    list.push(word);
    fetched.set(word.input, list);
  }
  for (const [input, words] of fetched) {
    setCachedSenses(input, sourceLang, targetLang, words);
    byWord.set(input, words);
  }
  return byWord;
}
