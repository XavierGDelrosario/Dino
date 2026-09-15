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
import { matchesReadingSide, orderSenses } from "./senseOrder";
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
  /** JMdict's "common" flag for the sense's ENTRY; null for non-JMdict rows, and on a
   *  database that predates migration 20260769. Ranks a kanji search (senseOrder.ts). */
  isCommon?: boolean | null;
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
    isCommon: row.is_common ?? null,
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
  // The full sense list, not a limit(1) read: which sense is preferred is decided by
  // orderSenses over ALL of them (a kanji term's uk rows included), and a one-row query
  // could only ever pick by the database order.
  const senses = await findWordTranslations(params);
  return senses[0] ?? null;
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

  const { data, error } = await readOrdered<WordRow[]>((orderCol) => byTerm(
    supabase
      .from("words")
      .select<string, WordRow>("*")
      .eq("source_lang", sourceLang)
      .eq("target_lang", targetLang)
      // Skip rows projected by OLDER logic: a stale hit here would short-circuit the edge
      // and serve the pre-fix projection forever. As a miss it goes to the edge, which
      // re-projects it in place. See src/lib/projection.ts.
      .or(FRESH),
    [input],
  )
    .order("is_verified", { ascending: false })
    .order(orderCol, { ascending: true, nullsFirst: false }));

  if (error) throw toServiceError(error);
  const words = orderSenses((data ?? []).map(toWord), input, sourceLang, targetLang);
  setCachedSenses(input, sourceLang, targetLang, words); // no-op when empty
  return words;
}

/**
 * A cache row answers `term` when it headwords as it — or, for a KANJI term, when it
 * carries the term as its reading. That second arm is a `uk` entry: it headwords as its
 * kana and keeps its kanji in input_reading, so an input-only read for 為 found just 為
 * read い ("the second string of a koto") and never ため. The edge has always matched
 * both sides; this is the client catching up, for kanji terms only — a kana term already
 * misses here and is resolved by the edge.
 */
function belongsTo(word: Word, term: string): boolean {
  return word.input === term || (matchesReadingSide(term) && word.inputReading === term);
}

/** PostgREST `or` grammar treats , ( ) . as syntax, so every value is quoted. */
const quoteFilterValue = (v: string) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** Narrow a words query to `terms`: input only, plus input_reading for kanji terms. */
function byTerm<Q extends { in(column: string, values: string[]): Q; or(filter: string): Q }>(
  query: Q,
  terms: string[],
): Q {
  const kanji = terms.filter(matchesReadingSide);
  if (kanji.length === 0) return query.in("input", terms);
  const list = (values: string[]) => values.map(quoteFilterValue).join(",");
  return query.or(`input.in.(${list(terms)}),input_reading.in.(${list(kanji)})`);
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
  // A kanji term can put the list in the URL twice (input + input_reading).
  const chunks = chunkForUrlFilter(misses, { repeats: misses.some(matchesReadingSide) ? 2 : 1 });
  const rowsPerChunk = await mapLimit(chunks, URL_FILTER_CONCURRENCY, async (inputs) => {
    const { data, error } = await readOrdered<WordRow[]>((orderCol) => byTerm(
      supabase
        .from("words")
        .select<string, WordRow>("*")
        .eq("source_lang", sourceLang)
        .eq("target_lang", targetLang)
        .or(FRESH), // stale projections are a MISS (see findWordTranslations)
      inputs,
    )
      .order("is_verified", { ascending: false })
      .order(orderCol, { ascending: true, nullsFirst: false }));
    if (error) throw toServiceError(error);
    return data ?? [];
  });

  // Assign each row to every term it answers (a kanji term also collects the uk rows
  // that carry it as their reading), order each term's senses, memoize non-empty ones.
  // Deduped by word_id: a row can come back from two chunks.
  const seen = new Set<string>();
  const words = rowsPerChunk.flat().filter((row) => !seen.has(row.word_id) && seen.add(row.word_id)).map(toWord);
  for (const input of misses) {
    const senses = orderSenses(words.filter((w) => belongsTo(w, input)), input, sourceLang, targetLang);
    if (senses.length === 0) continue;
    setCachedSenses(input, sourceLang, targetLang, senses);
    byWord.set(input, senses);
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
