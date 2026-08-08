// Read access to the global `words` dictionary cache: verified, system-owned senses,
// READ-ONLY to clients (RLS allows SELECT of verified rows only) — the `translate` edge
// function is the sole writer. User-authored content lives in `user_words`, never here.
//
// This file owns the DB-row ↔ domain `Word` mapping; nothing else reads `words`.

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
  /** DIFFICULTY AXIS: corpus-frequency rank (lower = more common), resolved to a level
   *  by services/difficulty. Distinct from the relatedness axis — never conflate. */
  frequency: number | null;
  /** Normalized 1..5 curated difficulty (JLPT/HSK); overrides frequency. null today. */
  difficultyOverride: number | null;
  /** PROFICIENCY LABEL axis: the curated per-language band (JLPT, CEFR …), ascending =
   *  HARDER, resolved to a display label by services/proficiency. Null until a wordlist
   *  is ingested. SEPARATE from the frequency axis above — never conflate. */
  proficiencyBand: number | null;
  /** STABLE JMdict identity: the sense this row was projected from, INDEPENDENT of the
   *  mutable headword — what `user_words` pins to via word_id and what a re-projection
   *  keys on. Null for non-JMdict rows. */
  jmdictEntryId: string | null;
  /** JA→EN: the entry's sense index (0 = primary); EN→JA: match rank. */
  jmdictSensePos: number | null;
  /**
   * SENSE ENRICHMENT (migration 20260750) — null until a sense has been written, which
   * is most of them. JA→EN rows only: for EN→JA `jmdictSensePos` is a match rank, not a
   * sense index, so nothing can be keyed on it.
   *
   * A sentence demonstrating THIS sense, which is what a gloss list structurally cannot
   * do — 辛い "spicy" and 辛い "painful" read identically in English, but one sentence
   * each settles them.
   */
  example: string | null;
  exampleGloss: string | null;
  /** A monolingual Japanese definition of this sense, written as a JA dictionary writes
   *  one. Carries usage a gloss cannot: 遜色 glossed "inferiority" invites the unnatural
   *  遜色がある, where the definition records 多くは「ない」を伴って使う. */
  definitionSource: string | null;
  /** How the target reads inside `example` — set only where kuromoji reads it wrong and
   *  no rewrite fixes it (辛い→つらい). Null means kuromoji is trusted, as elsewhere. */
  exampleReading: string | null;
  isVerified: boolean;
}

// Derived from the generated schema types, so a renamed/removed column becomes a
// COMPILE error in toWord below. (`.select("*")` returns extra columns toWord ignores.)
type WordRow = Database["public"]["Tables"]["words"]["Row"];

// ‼️ AVAILABILITY: PostgREST rejects an ORDER BY on a column the database lacks with
// 42703, failing the whole query — so a client ahead of migration 20260751 would lose
// dictionary lookups entirely. Same treatment as the embed in userWords.ts: ask for the
// curated order, fall back to jmdict_sense_pos on 42703. Not a degraded order — that's
// what sense_rank is seeded to, minus any hand-curated overrides.
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
 * The single preferred dictionary sense for a language pair, or null. NFC-normalized
 * here, so the cache key and DB query always match what the edge stored.
 */
export async function findCachedWord(params: {
  input: string;
  sourceLang: LangCode;
  targetLang: LangCode;
}): Promise<Word | null> {
  const { sourceLang, targetLang } = params;
  const input = nfc(params.input);

  // A memoized sense list has the preferred sense first, so serve it with no round-trip.
  // A miss keeps the cheaper limit(1) query and does NOT populate the cache — one row is
  // an incomplete sense list, and only findWordTranslations caches the complete set.
  const cached = getCachedSenses(input, sourceLang, targetLang);
  if (cached) return cached[0] ?? null;

  const { data, error } = await readOrdered<WordRow[]>((orderCol) => supabase
    .from("words")
    .select<string, WordRow>("*")
    .eq("input", input)
    .eq("source_lang", sourceLang)
    .eq("target_lang", targetLang)
    // Skip rows projected by OLDER logic: a stale hit here would short-circuit the edge
    // and serve the pre-fix projection forever. As a miss it goes to the edge, which
    // re-projects it in place. See src/lib/projection.ts.
    .or(FRESH)
    .order("is_verified", { ascending: false })
    .order(orderCol, { ascending: true, nullsFirst: false })
    .limit(1));

  if (error) throw toServiceError(error);

  return data?.[0] ? toWord(data[0]) : null;
}

/**
 * ALL known senses of a word for a language pair. A word legitimately has several
 * meanings and the single-word UI shows them all; findCachedWord returns just the
 * preferred one.
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

/** Cap in-flight chunk queries so a long paste can't open a request per chunk. */
const URL_FILTER_CONCURRENCY = 6;

/**
 * Batched `findWordTranslations`: all senses for many words in one query, keyed by the
 * stored input, so a caller can map a whole paragraph without N round-trips.
 */
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

  // CHUNK the `.in()` filter by encoded size: inlining every term builds a GET URL a
  // long paste can push past the request limit, and then the caller sees NO meanings for
  // ANY word. Each term lands in exactly one chunk, so the per-input ordering the
  // grouping below relies on survives. See lib/urlFilter.ts.
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

  // Group by stored headword (= the query input for these dictionary-form lookups),
  // then memoize each non-empty group.
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

/**
 * Dictionary senses BY ID — for surfaces that hold a `word_id` and need to show what
 * it means (the admin quality panel, which stores the exact sense a user flagged).
 *
 * OUTPUT: Map keyed by wordId; ids with no row are simply absent.
 * CONSTRAINTS: reads verified rows through RLS like every other client read. NOT
 * projection-gated (no FRESH filter): the caller wants to see the row that was
 * REPORTED, even — especially — if it is stale. A staleness filter here would blank
 * the report that told us the row was wrong.
 */
export async function findWordsByIds(wordIds: string[]): Promise<Map<string, Word>> {
  const unique = [...new Set(wordIds.filter(Boolean))];
  const out = new Map<string, Word>();
  if (unique.length === 0) return out;

  const chunks = chunkForUrlFilter(unique);
  const rows = await mapLimit(chunks, URL_FILTER_CONCURRENCY, async (ids) => {
    const { data, error } = await supabase
      .from("words")
      .select<string, WordRow>("*")
      .in("word_id", ids);
    if (error) throw toServiceError(error);
    return data ?? [];
  });
  for (const row of rows.flat()) out.set(row.word_id, toWord(row));
  return out;
}
