// =========================================================
// `translate` Edge Function — the ONLY place translation happens.
//
// Holds a service-role Supabase client so it can write VERIFIED words to the
// global cache — something browser clients can never do (RLS forbids
// is_verified = true from clients).
//
// PRIMARY PROVIDER = JMdict (self-hosted). On a cache miss we call the
// jmdict_lookup() SQL function (see supabase/migrations/20260618_jmdict.sql),
// which returns ALL matching senses for the pair (both JA->EN and EN->JA). A
// real dictionary is MULTI-SENSE, so unlike the old single-result MT flow this
// function projects MANY verified `words` rows per lookup and returns them all.
//
// Find-or-Create (server side, race-safe against duplicate work):
//   1. Look for existing verified translations -> return them, no lookup.
//   2. Miss -> jmdict_lookup(); fall back to the (unimplemented) MT provider.
//   3. No result -> { translated: false, ... }.
//   4. Success -> upsert verified words (readings ride inline on each row) and return.
//
// READINGS: each `words` row carries input_reading / translation_reading inline.
// That is the furigana source for the no-context surface (single-word lookups,
// flashcards), where kuromoji is unreliable. Sentence furigana uses client-side
// kuromoji (context-aware). There is NO separate readings table.
//
// MT FALLBACK: callTranslationProvider() is an UNIMPLEMENTED stub that returns
// null. JMdict is the only wired provider for the POC; words it lacks (and the
// whole-paragraph display translation) get no result until an MT provider is
// added there.
//
// Required env: the auto-provided SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.
//
// CROSS-RUNTIME MIRROR: toWord() and the upsert onConflict tuple hand-mirror
// src/services/words/repository.ts (separate Deno runtime) — keep them in sync.
// =========================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Stamp written onto every projected `words` row (projection_version). BUMP this
// whenever the source data (a JMdict re-ingest) or the projection logic
// (jmdict_lookup / the toWord projection below — readings, headword, uk, ranking,
// dictionary_ref) changes, so the deferred (#5) re-projection sweep can find
// rows it must rebuild (those with projection_version < this).
//   1 = pre-stable-identity baseline (no dictionary_ref)
//   2 = stable JMdict identity (#1: jmdict_entry_id/sense_pos + dictionary_ref)
const CURRENT_PROJECTION_VERSION = 2;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
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

// snake_case DB row -> camelCase Word (mirrors src/services/words/repository.ts).
function toWord(r: WordRow) {
  return {
    wordId: r.word_id,
    input: r.input,
    translation: r.translation,
    sourceLang: r.source_lang,
    targetLang: r.target_lang,
    inputReading: r.input_reading ?? null,
    translationReading: r.translation_reading ?? null,
    jmdictEntryId: r.jmdict_entry_id ?? null,
    jmdictSensePos: r.jmdict_sense_pos ?? null,
    isVerified: r.is_verified,
  };
}

// One projected sense: the translation plus optional per-side READINGS (kana for
// the Japanese side). JA->EN sets inputReading; EN->JA sets translationReading.
interface ProviderResult {
  translation: string;
  inputReading?: string | null;
  translationReading?: string | null;
  // JA->EN: the canonical JA headword (kanji if the entry has one, else kana) to
  // store as `input`, so a kana search keeps the kanji. null/undefined → use the
  // search term as-is (EN->JA, MT).
  headword?: string | null;
  // STABLE JMdict source identity (null for the MT fallback). Folded into the
  // row's dictionary_ref so re-projection lands on the SAME row regardless of how
  // the headword/translation render. JA->EN: sensePos = the sense index; EN->JA:
  // the match rank (informational — identity there is the input + entryId).
  entryId?: string | null;
  sensePos?: number | null;
}

// deno-lint-ignore no-explicit-any
type Supa = any;

// PRIMARY provider: query the self-hosted JMdict via the jmdict_lookup() SQL
// function. Returns one ProviderResult per sense (JA->EN) / matched entry
// (EN->JA), already ordered primary-first by the function. [] when no match.
async function lookupJMdict(
  supabase: Supa,
  input: string,
  sourceLang: string,
  targetLang: string,
): Promise<ProviderResult[]> {
  const { data, error } = await supabase.rpc("jmdict_lookup", {
    p_input: input,
    p_source: sourceLang,
    p_target: targetLang,
  });
  if (error) throw new Error(error.message);
  return (data ?? []).map((row: {
    translation: string;
    input_reading: string | null;
    translation_reading: string | null;
    writing: string | null;
    sense_position: number | null;
    jmdict_entry_id: string | null;
  }) => ({
    translation: row.translation,
    inputReading: row.input_reading ?? null,
    translationReading: row.translation_reading ?? null,
    headword: row.writing ?? null,
    entryId: row.jmdict_entry_id ?? null,
    sensePos: row.sense_position ?? null,
  }));
}

// MT FALLBACK — UNIMPLEMENTED for the POC. Invoked only when JMdict has no
// match. Returns null (no result). Implement a real MT provider here (auth
// header, request shape, response parsing are all provider-specific — e.g. the
// DeepL example below) to cover words JMdict lacks and paragraph translation.
//   const key = Deno.env.get("DEEPL_API_KEY"); ...
//   const text = (await res.json())?.translations?.[0]?.text;
//   return text ? { translation: text } : null;
async function callTranslationProvider(
  _text: string,
  _sourceLang: string,
  _targetLang: string,
): Promise<ProviderResult | null> {
  return null;
}

/** All verified `words` rows for a lookup tuple (the multi-sense cache read). */
async function fetchVerified(
  supabase: Supa,
  input: string,
  sourceLang: string,
  targetLang: string,
): Promise<WordRow[]> {
  // Match the search term against EITHER the stored headword (`input`, e.g. 猫)
  // OR its reading (`input_reading`, e.g. ねこ), so a hiragana search resolves to
  // the kanji-headword rows the projection stores.
  const { data, error } = await supabase
    .from("words")
    .select("*")
    .eq("source_lang", sourceLang)
    .eq("target_lang", targetLang)
    .eq("is_verified", true)
    .or(`input.eq.${input},input_reading.eq.${input}`)
    // Primary sense first, deterministically: jmdict_sense_pos is 0 for the
    // primary JA→EN sense / best-ranked EN→JA entry (nulls last for MT rows).
    .order("jmdict_sense_pos", { ascending: true, nullsFirst: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as WordRow[];
}

/** The success response for a set of verified rows (primary = first row). */
function respondWords(rows: WordRow[]) {
  return {
    translated: true,
    translation: rows[0].translation,
    word: toWord(rows[0]),
    words: rows.map(toWord),
  };
}

// HTTP handler — the request entry point.
// OUTPUT (JSON): { translated, translation, word, words } on success;
//   word = primary sense (back-compat), words = all senses. { error } + 4xx/5xx otherwise.
// CONSTRAINTS: POST only (+ OPTIONS/CORS); requires input/sourceLang/targetLang;
// rejects source == target; NFC-normalizes input; persist=false skips the cache
// (display-only); verified writes are system-owned (service role bypasses RLS).
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let input = "";
  let sourceLang = "";
  let targetLang = "";
  let persist = true;
  try {
    const body = await req.json();
    // NFC-normalize to match the client's cache keys + jmdict_* rows.
    input = String(body.input ?? "").trim().normalize("NFC");
    sourceLang = String(body.sourceLang ?? "");
    targetLang = String(body.targetLang ?? "");
    // persist=false → translate for display only (a whole paragraph in context)
    // without reading/writing the cache; we don't store unique paragraphs.
    persist = body.persist !== false;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  if (!input || !sourceLang || !targetLang) {
    return json({ error: "input, sourceLang and targetLang are required" }, 400);
  }
  if (sourceLang === targetLang) {
    return json({ error: "Source and target language are the same" }, 400);
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // 1. Verified-cache check (all senses) -> no JMdict re-query. Words only;
  //    display-only paragraph translations skip the cache entirely.
  if (persist) {
    const cached = await fetchVerified(supabase, input, sourceLang, targetLang);
    if (cached.length > 0) return json(respondWords(cached));
  }

  // 2. Resolve senses: JMdict first, then the (unimplemented) MT fallback.
  let results = await lookupJMdict(supabase, input, sourceLang, targetLang);
  if (results.length === 0) {
    const mt = await callTranslationProvider(input, sourceLang, targetLang);
    if (mt) results = [mt];
  }
  if (results.length === 0) {
    return json({ translated: false, translation: null, word: null, words: [] });
  }

  // 3. Display-only (paragraph): return the primary text without caching.
  if (!persist) {
    return json({
      translated: true,
      translation: results[0].translation,
      word: null,
      words: [],
    });
  }

  // 4. Persist every sense as a verified global word (service role bypasses RLS).
  //    Readings ride inline on each row; they are deterministic attributes, NOT
  //    part of the identity. Each row carries a STABLE dictionary_ref (its JMdict
  //    entry+sense, headword-independent) — the onConflict target — so re-running
  //    the projection after a logic change UPDATEs rows in place (word_id, hence
  //    user_words references, survive) instead of forking stale duplicates.
  //    DEDUPE by translation first: JMdict can yield several senses that aggregate
  //    to the SAME string (e.g. 私 → "I; me" twice). Keep the first (primary) of
  //    each — distinct translations carry distinct refs, so this also prevents a
  //    duplicate conflict key (a single ON CONFLICT cannot update one row twice,
  //    Postgres 21000).
  const seen = new Set<string>();
  const rows: Array<Record<string, unknown>> = [];
  for (const r of results) {
    // Store the canonical headword (kanji writing for JA->EN) as `input`, so a
    // kana search keeps the kanji and homophones split into their own kanji.
    const head = r.headword ?? input;
    // Dedupe by translation (UX: 私 must not list "I; me" twice). Distinct
    // translations always carry distinct dictionary_refs, so this also prevents
    // a duplicate onConflict key (Postgres 21000 "cannot update a row twice").
    const key = `${head} ${r.translation}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // STABLE conflict key — pins the row to its SOURCE sense, not the mutable
    // headword, so a re-projection UPDATEs this row in place (keeping word_id, so
    // user_words references survive) instead of forking a duplicate:
    //   JA-source (headword projected from the entry → unstable): '<entry>:<pos>'
    //   EN-source (input is the stable search term):              '<input>:<entry>'
    //   MT fallback (no JMdict entry):                            'mt:<input>'
    const ref = r.entryId == null
      ? `mt:${input}`
      : r.headword != null
        ? `${r.entryId}:${r.sensePos ?? 0}`
        : `${input}:${r.entryId}`;
    rows.push({
      input: head,
      translation: r.translation,
      source_lang: sourceLang,
      target_lang: targetLang,
      input_reading: r.inputReading ?? null,
      translation_reading: r.translationReading ?? null,
      jmdict_entry_id: r.entryId ?? null,
      jmdict_sense_pos: r.sensePos ?? null,
      dictionary_ref: ref,
      projection_version: CURRENT_PROJECTION_VERSION,
      is_verified: true,
    });
  }
  const { error: insertError } = await supabase
    .from("words")
    .upsert(rows, {
      onConflict: "dictionary_ref,source_lang,target_lang",
    });
  if (insertError) return json({ error: insertError.message }, 500);

  // 5. Return the full verified set (re-read for a consistent shape with the
  //    cache-hit path), primary sense first.
  const saved = await fetchVerified(supabase, input, sourceLang, targetLang);
  return json(saved.length > 0 ? respondWords(saved) : {
    translated: true,
    translation: results[0].translation,
    word: null,
    words: [],
  });
});
