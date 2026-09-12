// `translate` Edge Function — the ONLY place translation happens.
//
// Holds a service-role client so it can write VERIFIED words to the global cache, which
// browser clients can never do (RLS forbids is_verified = true from clients).
//
// Find-or-create per lookup: verified cache → jmdict_lookup() (multi-sense, so one
// lookup projects MANY `words` rows) → the Google MT fallback → { translated: false }.
// Readings ride inline on each row — the furigana source for the no-context surface;
// sentence furigana uses client-side kuromoji. There is NO separate readings table.
//
// Required env: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (auto-provided). Optional
// secrets: TRANSLATION_API_KEY (enables MT), TRANSLATION_API_URL (endpoint override).
//
// CROSS-RUNTIME MIRROR: toWord() and the upsert onConflict tuple hand-mirror
// src/services/words/repository.ts (separate Deno runtime) — keep them in sync.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
// Pure helpers live in _lib.ts so they're unit-testable from Node/Vitest.
import {
  applyInputAttributeOverride,
  corsHeaders,
  EN_JA_STOPWORDS,
  isEnglishFunctionWord,
  isMultiWord,
  inflectedVerbSurface,
  preferVerbSenses,
  expandSegmentResults,
  groupByInput,
  MAX_SEGMENTS,
  prepareSegments,
  lemmaCandidates,
  orderSensesForInput,
  parseAllowedOrigins,
  parseLearnRequest,
  projectMany,
  projectRows,
  resolvePerInputWithCandidates,
  resolvePerInputFirstHit,
  resolveServiceKey,
  toGoogleLang,
  userIdFromAuth,
  type ProviderResult,
  chunkForUrlFilter,
  shouldSkipMt,
  isEchoTranslation,
  isRomanizedName,
  dictionaryRefFor,
  curationKeyFor,
  preferWrittenForm,
} from "./_lib.ts";

// Stamp written onto every projected `words` row. BUMP whenever the source data (a
// re-ingest) or the projection logic changes, so a cached row that would serve a STALE
// ANSWER is re-projected. Don't bump when the row can be corrected in place (e.g. an
// ingest that backfills `words` directly) — that just stampedes the whole cache.
// See src/lib/projection.ts for the full contract and the version history.
const CURRENT_PROJECTION_VERSION = 15;

// The READ side of that stamp: a row below the current version is a cache MISS, and the
// re-projection upserts on `dictionary_ref` so it UPDATEs in place (word_id survives,
// `user_words.dictionary_word_id` never dangles). MT rows are gated too — the spend
// concern is handled by reviveMtRows, which re-serves and re-stamps the text we already
// paid for, so a bump never re-calls Google.
//
// MIRRORS src/lib/projection.ts (separate runtime; tests fail if the two drift).
const FRESH = `projection_version.gte.${CURRENT_PROJECTION_VERSION}`;

const SB_URL = Deno.env.get("SUPABASE_URL")!;
// resolveServiceKey handles the SERVICE_ROLE_SECRET → legacy-key precedence, so the
// function keeps RLS-bypass access after legacy API keys are disabled.
const SERVICE_KEY = resolveServiceKey({
  SERVICE_ROLE_SECRET: Deno.env.get("SERVICE_ROLE_SECRET"),
  SUPABASE_SERVICE_ROLE_KEY: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
})!;
// One client for the whole isolate — supabase-js is fetch-based and stateless here.
const supabase = createClient(SB_URL, SERVICE_KEY);

function json(
  body: unknown,
  status = 200,
  cors: Record<string, string> = { "Access-Control-Allow-Origin": "*" },
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
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
  part_of_speech: string[] | null;
  frequency: number | null;
  proficiency_band: number | null;
  difficulty_override: number | null;
  jmdict_entry_id: string | null;
  jmdict_sense_pos: number | null;
  example: string | null;
  example_gloss: string | null;
  definition_source: string | null;
  example_reading: string | null;
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
    partOfSpeech: r.part_of_speech ?? null,
    frequency: r.frequency ?? null,
    proficiencyBand: r.proficiency_band ?? null,
    difficultyOverride: r.difficulty_override ?? null,
    jmdictEntryId: r.jmdict_entry_id ?? null,
    jmdictSensePos: r.jmdict_sense_pos ?? null,
    example: r.example ?? null,
    exampleGloss: r.example_gloss ?? null,
    definitionSource: r.definition_source ?? null,
    exampleReading: r.example_reading ?? null,
    isVerified: r.is_verified,
  };
}

// deno-lint-ignore no-explicit-any
type Supa = any;

// PRIMARY provider: the self-hosted JMdict via jmdict_lookup(). One ProviderResult per
// sense (JA->EN) / matched entry (EN->JA), already primary-first. [] when no match.
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
    frequency: number | null;
    proficiency_band: number | null;
    part_of_speech: string[] | null;
  }) => ({
    translation: row.translation,
    inputReading: row.input_reading ?? null,
    translationReading: row.translation_reading ?? null,
    headword: row.writing ?? null,
    entryId: row.jmdict_entry_id ?? null,
    sensePos: row.sense_position ?? null,
    frequency: row.frequency ?? null,
    proficiencyBand: row.proficiency_band ?? null,
    partOfSpeech: row.part_of_speech ?? null,
  }));
}

// EN->JA is the slow direction and its long tail is the noisiest (acronym/mid-gloss
// matches), so cap it tighter than the SQL ceiling — the client shows 8 before "show
// more" anyway. (JA->EN is capped by jmdict_lookup's own LIMIT 12.)
const EN_JA_RESULT_LIMIT = 8;

// Resolve a lookup to its dictionary senses: EN->JA merges WordNet + the reverse-gloss
// jmdict_lookup, every other direction is straight jmdict_lookup. The caller's MT
// fallback runs only when this returns [].
async function resolveDictionary(
  supabase: Supa,
  input: string,
  sourceLang: string,
  targetLang: string,
): Promise<ProviderResult[]> {
  // GRAMMAR, not vocabulary: resolve to nothing. Callers read [] as "no entry".
  if (sourceLang === "EN" && targetLang === "JA" && isEnglishFunctionWord(input)) return [];
  // A PHRASE is not a headword, so skip both round-trips. It does NOT stop the request:
  // the empty result falls through to MT, which is the right answer for a phrase (and
  // what the client relies on when it sends a whole native-language sentence).
  if (sourceLang === "EN" && targetLang === "JA" && isMultiWord(input)) return [];
  if (sourceLang === "EN" && targetLang === "JA") {
    // Lemmatize via morphy candidates (cats→cat, ran→run) in TWO parallel round-trips —
    // the same union-query + first-hit machinery as the batch path, no per-candidate
    // queries. Gloss runs even when WordNet fills the cap: parallel, so no added latency.
    const candidates = lemmaCandidates(input, sourceLang);
    // Stopwords skip the pathological (and meaningless) gloss scan; WordNet still runs.
    const glossCands = candidates.filter((c) => !EN_JA_STOPWORDS.has(c.toLowerCase()));
    const [wnRows, glossRows] = await Promise.all([
      lookupWordNetMany(supabase, candidates),
      glossCands.length
        ? lookupJMdictMany(supabase, glossCands, sourceLang, targetLang)
        : Promise.resolve([] as { input: string; r: ProviderResult }[]),
    ]);
    const resolved = resolvePerInputWithCandidates(
      [input],
      new Map([[input, candidates]]),
      groupProviderByInput(wnRows),
      groupProviderByInput(glossRows),
      targetLang,
      EN_JA_RESULT_LIMIT,
    );
    const senses = resolved.get(input) ?? [];
    // The inflection is the only English POS signal available; let it settle the tie
    // ("worked" lemmatizes to "work" and otherwise leads with the noun 仕事).
    return inflectedVerbSurface(input, candidates) ? preferVerbSenses(senses) : senses;
  }
  // JA→EN (and every other pair): one provider, but the input may still need a lemma
  // candidate — kuromoji hands us IPADIC's 接す where JMdict carries only 接する. Surface
  // first, so 出す/話す are untouched; the extra candidate costs one RPC, not a paid call.
  const cands = lemmaCandidates(input, sourceLang);
  if (cands.length === 1) return lookupJMdict(supabase, input, sourceLang, targetLang);
  const byCand = groupProviderByInput(await lookupJMdictMany(supabase, cands, sourceLang, targetLang));
  return resolvePerInputFirstHit([input], new Map([[input, cands]]), byCand).get(input) ?? [];
}

// One DB row from a lookup function → a ProviderResult. Shared by single + batch.
type LookupRow = {
  translation: string;
  input_reading: string | null;
  translation_reading: string | null;
  writing: string | null;
  sense_position: number | null;
  jmdict_entry_id: string | null;
  frequency: number | null;
  proficiency_band: number | null;
  part_of_speech: string[] | null;
  // 20260764: the winning synset's English definition. Present on WordNet rows only —
  // jmdict_lookup is the gloss fallback for words WordNet lacks, and a word WordNet
  // lacks has no definition to give, so it does not return this column at all.
  definition_en?: string | null;
};
function rowToProvider(row: LookupRow): ProviderResult {
  return {
    translation: row.translation,
    inputReading: row.input_reading ?? null,
    translationReading: row.translation_reading ?? null,
    // Lands in `words.definition_source` — "the definition IN THE SOURCE LANGUAGE",
    // which for an EN→JA row is English, mirroring the Japanese definition a JA→EN row
    // carries. Undefined on every non-WordNet row, so this is null everywhere else.
    definitionSource: row.definition_en ?? null,
    headword: row.writing ?? null,
    entryId: row.jmdict_entry_id ?? null,
    sensePos: row.sense_position ?? null,
    frequency: row.frequency ?? null,
    proficiencyBand: row.proficiency_band ?? null,
    partOfSpeech: row.part_of_speech ?? null,
  };
}

// BATCH dictionary lookups: MANY inputs in ONE RPC (the cold-paragraph N+1 fix,
// migration 20260710). Rows come back tagged with the search `input` so callers can
// regroup per term. WordNet is the SEMANTIC EN->JA provider (lemma → synsets → the JA
// lemmas in each, resolved through JMdict); JMdict is the reverse-gloss/direct lookup.
// Candidates per lookup STATEMENT. Not a URL-length limit (that's chunkForUrlFilter)
// but a TIME one: EN→JA's reverse-gloss search is a trigram scan per candidate, and one
// statement covering a whole article's candidates blew Postgres's statement timeout —
// which fails the ENTIRE batch, so the reader showed an article with no words at all.
// Observed on prod as `translate.batch` / "canceling statement due to statement timeout"
// against en.wikinews articles, and it is the same wall the Learn pool dodges with
// `skipGlossFallback` (safe there because that pool is WordNet-guaranteed; an arbitrary
// article is not, so the coverage has to be kept and the work bounded instead).
const LOOKUP_CHUNK = 40;
/** …and a much smaller one for the gloss scan itself, measured as the service role on
 *  prod: 40 candidates took 8.5s and was CANCELLED, while WordNet did the same 40 in
 *  3.3s. It is the trigram scan that is expensive, at roughly 200ms per candidate. */
const GLOSS_CHUNK = 8;
/** Chunks in flight. Bounded so splitting one heavy statement doesn't just re-create it
 *  as N concurrent heavy statements competing for the same buffers — but high enough
 *  that an article's worth of chunks finishes in a couple of waves rather than ten. */
const LOOKUP_CONCURRENCY = 6;
/** Paid MT calls in flight. Same shape of bound as the lookups, applied to Google
 *  rather than Postgres: enough to stop a long tail of misses serialising into
 *  minutes, low enough not to look like a burst to the provider. */
const MT_CONCURRENCY = 6;

/** Run `fn` over `items` in bounded chunks, at most LOOKUP_CONCURRENCY at a time. */
async function inChunks<T>(
  items: string[],
  fn: (chunk: string[]) => Promise<T[]>,
  size = LOOKUP_CHUNK,
): Promise<T[]> {
  const chunks: string[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  const out: T[] = [];
  for (let i = 0; i < chunks.length; i += LOOKUP_CONCURRENCY) {
    const wave = await Promise.all(chunks.slice(i, i + LOOKUP_CONCURRENCY).map(fn));
    for (const rows of wave) out.push(...rows);
  }
  return out;
}

async function lookupJMdictMany(
  supabase: Supa, inputs: string[], sourceLang: string, targetLang: string,
): Promise<{ input: string; r: ProviderResult }[]> {
  return inChunks(inputs, async (chunk) => {
    const { data, error } = await supabase.rpc("jmdict_lookup_many", {
      p_inputs: chunk, p_source: sourceLang, p_target: targetLang,
    });
    if (error) throw new Error(error.message);
    return (data ?? []).map((row: LookupRow & { input: string }) => ({ input: row.input, r: rowToProvider(row) }));
  }, sourceLang === "EN" && targetLang === "JA" ? GLOSS_CHUNK : LOOKUP_CHUNK);
}
async function lookupWordNetMany(
  supabase: Supa, inputs: string[],
): Promise<{ input: string; r: ProviderResult }[]> {
  return inChunks(inputs, async (chunk) => {
    const { data, error } = await supabase.rpc("wordnet_en_ja_lookup_many", { p_inputs: chunk });
    if (error) throw new Error(error.message);
    return (data ?? []).map((row: LookupRow & { input: string }) => ({ input: row.input, r: rowToProvider(row) }));
  });
}

function groupProviderByInput(rows: { input: string; r: ProviderResult }[]): Map<string, ProviderResult[]> {
  const out = new Map<string, ProviderResult[]>();
  for (const { input, r } of rows) {
    const list = out.get(input);
    if (list) list.push(r);
    else out.set(input, [r]);
  }
  return out;
}

// Batch counterpart of resolveDictionary: resolve every input's dictionary senses
// in one (JA→EN / other) or two (EN→JA: WordNet + gloss, merged per input) RPCs.
// Inputs with no match are simply absent from the returned map.
async function resolveDictionaryMany(
  supabase: Supa, inputs: string[], sourceLang: string, targetLang: string,
  /** Skip the EN→JA reverse-gloss scan entirely (see resolveBatch's flag). */
  skipGlossFallback = false,
): Promise<Map<string, ProviderResult[]>> {
  if (inputs.length === 0) return new Map();
  const out = new Map<string, ProviderResult[]>();
  if (sourceLang === "EN" && targetLang === "JA") {
    // Lemmatize like the single-word path but in ONE round-trip: query both providers
    // over the UNION of every token's candidates, then pick each token's winning lemma
    // and re-key to the surface token. Function words are dropped FIRST, so the reader
    // renders them as plain grammar rather than colouring "an" as an addable word.
    const inputs2 = inputs.filter((i) => !isEnglishFunctionWord(i));
    if (inputs2.length === 0) return out;
    const candsByInput = new Map(inputs2.map((i) => [i, lemmaCandidates(i, sourceLang)] as const));
    const allCands = [...new Set([...candsByInput.values()].flat())];
    // WordNet FIRST, then the gloss scan over only what it missed. These used to run in
    // parallel over every candidate, which is what made a whole article's worth of
    // candidates exceed the statement timeout and fail the entire batch — the reader
    // then showed an article with NO words at all.
    //
    // Sequencing them is a straight win because the fallback is the expensive half and
    // is barely needed: measured over 3 en.wikinews articles (180 keys), WordNet
    // resolved 158 and the gloss scan added 16 — and most of those 16 were grammar
    // words (whether, under, per) or proper nouns (Peshawar, iPhone, Qaeda) that aren't
    // vocabulary anyway. So it now runs over ~1/10th the candidates.
    //
    // The trade: a word WordNet DID resolve no longer gets its sense list topped up
    // from the gloss search. WordNet returns ~5 senses per candidate, so the cap is
    // rarely the binding constraint, and the single-word path still runs both providers
    // in full for anyone who taps the word to ask properly.
    //
    // WordNet itself is asked in TWO passes for the same reason. `lemmaCandidates`
    // emits ~4 forms per token and candidate #0 is always the surface, which is also
    // what usually resolves — so asking about every candidate up front does ~4x the
    // work to answer the same question. Pass 1 takes the surfaces; pass 2 asks only
    // about the fallback forms of tokens that are still unresolved. First-hit-wins is
    // unchanged: the merged map is the same one a single pass would have produced.
    const surfaces = [...new Set(inputs2.map((i) => candsByInput.get(i)?.[0] ?? i))];
    const wnByCand = groupProviderByInput(await lookupWordNetMany(supabase, surfaces));
    const stillMissing = (i: string) =>
      !(candsByInput.get(i) ?? []).some((c) => wnByCand.get(c)?.length);
    const fallbackCands = [
      ...new Set(inputs2.filter(stillMissing).flatMap((i) => (candsByInput.get(i) ?? []).slice(1))),
    ];
    if (fallbackCands.length) {
      for (const { input, r } of await lookupWordNetMany(supabase, fallbackCands)) {
        const list = wnByCand.get(input);
        if (list) list.push(r);
        else wnByCand.set(input, [r]);
      }
    }
    // Stopwords go to WordNet only, not the pathological gloss scan — as does
    // everything when the caller says the inputs are already WordNet-resolvable.
    const glossCands = skipGlossFallback
      ? []
      : allCands.filter(
          (c) =>
            !EN_JA_STOPWORDS.has(c.toLowerCase()) &&
            // …and only where WordNet came back empty for this candidate's whole input.
            !(wnByCand.get(c)?.length),
        );
    const glossByCand = groupProviderByInput(
      glossCands.length
        ? await lookupJMdictMany(supabase, glossCands, sourceLang, targetLang)
        : [],
    );
    for (const [input, results] of resolvePerInputWithCandidates(
      inputs2, candsByInput, wnByCand, glossByCand, targetLang, EN_JA_RESULT_LIMIT,
    )) {
      // Same inflection bias as the single-word path.
      const cands = candsByInput.get(input) ?? [];
      out.set(input, inflectedVerbSurface(input, cands) ? preferVerbSenses(results) : results);
    }
  } else {
    // Same first-hit-wins resolution as the single-word path, over the UNION of every
    // token's candidates, still in ONE round-trip.
    const candsByInput = new Map(inputs.map((i) => [i, lemmaCandidates(i, sourceLang)] as const));
    const allCands = [...new Set([...candsByInput.values()].flat())];
    const byCand = groupProviderByInput(await lookupJMdictMany(supabase, allCands, sourceLang, targetLang));
    for (const [input, results] of resolvePerInputFirstHit(inputs, candsByInput, byCand)) {
      out.set(input, results);
    }
  }
  return out;
}

// ── English frequency (difficulty axis for EN-source words) ─────────────────
// For an EN→JA lookup `words.frequency` must be the ENGLISH input's own corpus
// frequency, not the matched JA translation's — so override with
// english_frequency[lower(input)] ?? NULL, never the JA value. Ordering is already
// decided in SQL before this, so it only corrects the stored attribute. Fail-open;
// no-op for every non-EN→JA direction.
async function applyEnglishFrequency(
  supabase: Supa,
  perInput: { input: string; results: ProviderResult[] }[],
  sourceLang: string,
  targetLang: string,
): Promise<void> {
  if (sourceLang !== "EN" || targetLang !== "JA" || perInput.length === 0) return;
  const keys = [...new Set(perInput.map((p) => p.input.toLowerCase()))];
  const { data, error } = await supabase
    .from("english_frequency")
    .select("surface, frequency")
    .in("surface", keys);
  if (error) {
    console.error("english_frequency lookup failed:", error.message);
    return; // fail-open — leave frequencies untouched
  }
  const freq = new Map<string, number>();
  for (const r of (data ?? []) as { surface: string; frequency: number }[]) freq.set(r.surface, r.frequency);
  applyInputAttributeOverride(perInput, freq, "frequency"); // English freq or NULL, never the JA one
}

/** As applyEnglishFrequency, but for the CEFR band (A1→1 … C2→6) instead of the matched
 *  JA translation's JLPT band. In the leveling model the band LEADS over frequency, so
 *  this also drives an English word's difficulty. */
async function applyEnglishProficiency(
  supabase: Supa,
  perInput: { input: string; results: ProviderResult[] }[],
  sourceLang: string,
  targetLang: string,
): Promise<void> {
  if (sourceLang !== "EN" || targetLang !== "JA" || perInput.length === 0) return;
  const keys = [...new Set(perInput.map((p) => p.input.toLowerCase()))];
  const { data, error } = await supabase
    .from("english_proficiency")
    .select("surface, band")
    .in("surface", keys);
  if (error) {
    console.error("english_proficiency lookup failed:", error.message);
    return; // fail-open — leave bands untouched
  }
  const band = new Map<string, number>();
  for (const r of (data ?? []) as { surface: string; band: number }[]) band.set(r.surface, r.band);
  applyInputAttributeOverride(perInput, band, "proficiencyBand"); // CEFR band or NULL, never the JA JLPT one
}

/** Stamp the authored curation (migration 20260752) onto the projected rows — example,
 *  gloss, definition, pinned reading, display rank — read from the server-only
 *  `sense_curation` so the client only ever reads `words`.
 *
 *  Keyed on `dictionary_ref`, the identity the cache is unique on, which is what makes
 *  it work in BOTH directions: an (entry, sense) key can't express EN→JA, where
 *  jmdict_sense_pos is the ranker's OUTPUT and a curation would pin to a position the
 *  ranker recomputes. Fail-open — curation is an enhancement, never a reason to fail. */
async function applySenseExamples(
  supabase: Supa,
  perInput: { input: string; results: ProviderResult[] }[],
  sourceLang: string,
  targetLang: string,
): Promise<void> {
  if (perInput.length === 0) return;
  const keys = new Set<string>();
  for (const p of perInput) {
    for (const r of p.results) keys.add(curationKeyFor(dictionaryRefFor(r, p.input)));
  }
  if (keys.size === 0) return;

  const { data, error } = await supabase
    .from("sense_curation")
    .select("dictionary_ref, example, example_gloss, definition_source, example_reading, sense_rank")
    .eq("source_lang", sourceLang)
    .eq("target_lang", targetLang)
    .in("dictionary_ref", [...keys]);
  if (error) {
    console.error("sense_curation lookup failed:", error.message);
    return; // fail-open
  }

  type Row = {
    dictionary_ref: string;
    example: string | null;
    example_gloss: string | null;
    definition_source: string | null;
    example_reading: string | null;
    sense_rank: number | null;
  };
  const byRef = new Map<string, Row>();
  for (const r of (data ?? []) as Row[]) byRef.set(r.dictionary_ref, r);
  if (byRef.size === 0) return;

  for (const p of perInput) {
    for (const r of p.results) {
      const hit = byRef.get(curationKeyFor(dictionaryRefFor(r, p.input)));
      if (!hit) continue;
      r.example = hit.example;
      r.exampleGloss = hit.example_gloss;
      // ‼️ `??`, not `=`. Since 20260764 a definition can arrive from TWO places: hand
      // authored here, or generated from the WordNet synset the EN→JA row resolved
      // through. Authored still wins — but a curation row written for some OTHER field
      // (a pinned reading, a sense_rank) carries definition_source NULL, and a plain
      // assignment would let that blank erase a definition the lookup had supplied.
      r.definitionSource = hit.definition_source ?? r.definitionSource;
      r.exampleReading = hit.example_reading;
      r.senseRank = hit.sense_rank;
    }
  }
}

// Google Cloud Translation v2 (REST, API-key auth). Overridable via TRANSLATION_API_URL.
const DEFAULT_TRANSLATION_API_URL =
  "https://translation.googleapis.com/language/translate/v2";

// MT FALLBACK — invoked only when JMdict has no match: words JMdict lacks AND the
// paragraph display gloss. Secret names are provider-agnostic, so swapping providers is
// a body change here and nothing else.
//
// Degrades to null (→ "no result") on EVERY failure mode — missing key, non-2xx,
// network, empty payload — so flaky MT never 500s a request or breaks the paragraph
// fan-out. Readings are JMdict-only, so an MT result carries none.
//
// Google v2 accepts REPEATED `q`, translating each as its own unit and returning them in
// request order. That index alignment is the whole point of the inline reader gloss.
// Same char billing as one blob; one round-trip either way.
//
// OUTPUT: one entry per input in order (null where the provider gave nothing), or null
// when MT is unconfigured / the whole call failed.
async function callTranslationProviderMany(
  texts: string[],
  sourceLang: string,
  targetLang: string,
): Promise<(string | null)[] | null> {
  const key = Deno.env.get("TRANSLATION_API_KEY");
  if (!key) return null; // not configured → behaves like the old no-MT stub
  if (texts.length === 0) return [];

  const url = Deno.env.get("TRANSLATION_API_URL") ?? DEFAULT_TRANSLATION_API_URL;
  const chars = texts.reduce((n, t) => n + t.length, 0);
  try {
    const res = await fetch(`${url}?key=${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        q: texts,
        source: toGoogleLang(sourceLang),
        target: toGoogleLang(targetLang),
        format: "text", // plain text in/out — no HTML-entity escaping
      }),
    });
    if (!res.ok) {
      console.error(`MT provider HTTP ${res.status}: ${await res.text()}`);
      return null;
    }
    const body = await res.json();
    const translations: unknown = body?.data?.translations;
    const out = texts.map((_, i) => {
      const t = Array.isArray(translations)
        ? (translations[i] as { translatedText?: unknown } | undefined)?.translatedText
        : undefined;
      return typeof t === "string" && t ? t : null;
    });
    // One structured line per PAID call: spend = sum(mt_chars) over these logs.
    console.log(JSON.stringify({
      evt: "mt_spend",
      mt_chars: chars,
      segments: texts.length,
      source: toGoogleLang(sourceLang),
      target: toGoogleLang(targetLang),
      ok: out.some(Boolean),
    }));
    return out;
  } catch (e) {
    console.error("MT provider request failed:", e);
    return null;
  }
}

// WORD-level MT. The paragraph gloss calls ...Many directly and must NOT inherit these
// word-only guards. null = "MT gave us nothing", so callers refund what they reserved.
async function callTranslationProvider(
  text: string,
  sourceLang: string,
  targetLang: string,
): Promise<ProviderResult | null> {
  const out = await callTranslationProviderMany([text], sourceLang, targetLang);
  const translated = out?.[0];
  if (!translated) return null;
  // Google echoes what it can't translate; caching that mints a verified row whose
  // meaning is the word itself. The chars are already spent — this keeps the cache clean.
  if (isEchoTranslation(text, translated)) {
    console.log(JSON.stringify({ evt: "mt_echo_dropped", chars: text.length }));
    return null;
  }
  return { translation: translated };
}

// ── Per-user RESTRICTIONS (migration 20260620 + services/entitlements.ts) ──
// The MT call is the only PAID path, so limits are enforced HERE — the hard gate the
// client can't bypass. Both resolve from `user_limits` → env → built-in default; keep
// these in sync with DEFAULT_LIMITS in services/entitlements.ts.
const DEFAULT_PARAGRAPH_CHAR_LIMIT = 2000;
const DEFAULT_MONTHLY_CHAR_QUOTA = 450_000;
// Enforced BEFORE any dictionary lookup, so a pathological input can't hit the
// UNMETERED JMdict/WordNet scan (the paragraph limit only gates the paid path).
const MAX_INPUT_CHARS = 20_000;

interface ResolvedLimits {
  paragraphCharLimit: number;
  monthlyCharQuota: number;
}

/** Effective limits for the caller: their `user_limits` override, else env, else
 *  the built-ins. Read with the service role (bypasses RLS). */
async function resolveLimits(supabase: Supa, userId: string | null): Promise<ResolvedLimits> {
  const paragraphFallback =
    Number(Deno.env.get("PARAGRAPH_CHAR_LIMIT")) || DEFAULT_PARAGRAPH_CHAR_LIMIT;
  const monthlyFallback =
    Number(Deno.env.get("MONTHLY_CHAR_QUOTA")) || DEFAULT_MONTHLY_CHAR_QUOTA;
  if (!userId) {
    return { paragraphCharLimit: paragraphFallback, monthlyCharQuota: monthlyFallback };
  }
  const { data } = await supabase
    .from("user_limits")
    .select("paragraph_char_limit, monthly_char_quota")
    .eq("user_id", userId)
    .maybeSingle();
  return {
    paragraphCharLimit: data?.paragraph_char_limit ?? paragraphFallback,
    monthlyCharQuota: data?.monthly_char_quota ?? monthlyFallback,
  };
}

/**
 * ATOMICALLY reserve `chars` of the user's monthly quota — check + meter in one locked
 * RPC, no check-then-meter race. Fails OPEN on an RPC error: this cap is a free-tier
 * guard, not hard billing, so a DB blip shouldn't break translation.
 */
async function reserveQuota(
  supabase: Supa,
  userId: string,
  chars: number,
  quota: number,
): Promise<{ allowed: boolean; used: number; committed: boolean }> {
  const { data, error } = await supabase.rpc("consume_translation_quota", {
    p_user_id: userId,
    p_chars: chars,
    p_quota: quota,
  });
  if (error) {
    console.error("quota reservation failed:", error.message);
    return { allowed: true, used: 0, committed: false }; // fail open — nothing reserved
  }
  const row = Array.isArray(data) ? data[0] : data;
  const allowed = row?.allowed !== false;
  // `committed` = chars were actually added, so a later refund can't decrement
  // legitimate usage after a fail-open or a denial.
  return { allowed, used: row?.used ?? 0, committed: allowed };
}

// ── Global cost controls (#1) ───────────────────────────────────────────────
// EMERGENCY KILL-SWITCH: the MT_DISABLED secret stops ALL paid Google calls (degrading
// to JMdict-only) with no redeploy. Checked before any reserve, so it costs nothing.
function mtDisabled(): boolean {
  const v = (Deno.env.get("MT_DISABLED") ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

// Gating callers on this (not just callTranslationProvider) means an unconfigured or
// disabled MT never reserves quota — no phantom spend on a call that can't happen.
function mtConfigured(): boolean {
  return !mtDisabled() && !!Deno.env.get("TRANSLATION_API_KEY");
}

// GLOBAL monthly cap across ALL users — the aggregate billing risk the per-user quota
// can't bound. Always finite: this built-in applies when the env override is unset, so
// spend is never unbounded by default. ≈$30/mo worst case at Google rates.
const DEFAULT_GLOBAL_MONTHLY_CHAR_QUOTA = 2_000_000;
function globalCharQuota(): number {
  const v = Number(Deno.env.get("GLOBAL_MONTHLY_CHAR_QUOTA"));
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_GLOBAL_MONTHLY_CHAR_QUOTA;
}

/** Refund reserved chars when the paid call spent nothing. Best-effort: a failed refund
 *  leaves the reservation, the conservative direction (never under-counts spend). */
async function refundQuota(supabase: Supa, userId: string, chars: number): Promise<void> {
  const { error } = await supabase.rpc("refund_translation_quota", { p_user_id: userId, p_chars: chars });
  if (error) console.error("quota refund failed:", error.message);
}
async function refundGlobalQuota(supabase: Supa, chars: number): Promise<void> {
  const { error } = await supabase.rpc("refund_global_quota", { p_chars: chars });
  if (error) console.error("global quota refund failed:", error.message);
}

/** ATOMICALLY reserve `chars` against the GLOBAL monthly cap. Fails CLOSED: this is the
 *  hard SPEND backstop, so an uncheckable cap must not spend. (The per-user quota stays
 *  fail-open for availability; this one protects the bill.) */
async function reserveGlobalQuota(supabase: Supa, chars: number, quota: number): Promise<boolean> {
  const { data, error } = await supabase.rpc("consume_global_quota", {
    p_chars: chars,
    p_quota: quota,
  });
  if (error) {
    console.error("global quota reservation failed (deny):", error.message);
    return false; // fail closed — don't spend if the spend cap can't be verified
  }
  const row = Array.isArray(data) ? data[0] : data;
  return row?.allowed !== false;
}

// A REVERSE lookup INTO Japanese (EN→JA today): every sense shares the ENGLISH input's
// frequency (applyEnglishFrequency), so frequency can't order them and the projected
// sense rank is authoritative. Native JA→EN keeps frequency-first, which discriminates
// homograph ENTRIES (顔 → かお before かんばせ).
function isReverseIntoJa(sourceLang: string, targetLang: string): boolean {
  return sourceLang.toUpperCase() !== "JA" && targetLang.toUpperCase() === "JA";
}

/** All verified `words` rows for a lookup tuple (the multi-sense cache read). */
async function fetchVerified(
  supabase: Supa,
  input: string,
  sourceLang: string,
  targetLang: string,
): Promise<WordRow[]> {
  // Match the term against the stored headword (猫) OR its reading (ねこ), so a kana
  // search resolves the kanji rows. QUOTE the value: PostgREST's `or` grammar treats
  // comma/parens/period as syntax, so a raw term like "cat, dog" corrupts the filter.
  const q = `"${input.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  let query = supabase
    .from("words")
    .select("*")
    .eq("source_lang", sourceLang)
    .eq("target_lang", targetLang)
    .eq("is_verified", true)
    .or(`input.eq.${q},input_reading.eq.${q}`)
    .or(FRESH); // a stale projection is a MISS → re-projected in place
  if (isReverseIntoJa(sourceLang, targetLang)) {
    // EN→JA: uniform input-frequency → order by the projected sense rank.
    query = query
      .order("sense_rank", { ascending: true, nullsFirst: false })
      .order("jmdict_entry_id", { ascending: true, nullsFirst: false });
  } else {
    // JA→EN: MATCH jmdict_lookup's ranking so the cached primary equals the lookup's
    // even for a multi-ENTRY word (顔). sense_pos alone scrambled sense-0 ties.
    query = query
      .order("frequency", { ascending: false, nullsFirst: false })
      .order("jmdict_entry_id", { ascending: true, nullsFirst: false })
      .order("sense_rank", { ascending: true, nullsFirst: false });
  }
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  // PostgREST cannot express "the row whose headword IS the search term first", and the
  // set here is one word's senses, so the last key is applied in memory. Without it a uk
  // entry found via input_reading keeps the primary slot — the 質 → たち report.
  return preferWrittenForm((data ?? []) as WordRow[], input);
}

/** Mirrors fetchVerified's ORDER BY, for rows returned inline by upsert().select(), so
 *  the primary stays consistent across multi-entry words. */
function sortBySensePos(rows: WordRow[], reverseIntoJa = false): WordRow[] {
  const bySensePos = (a: WordRow, b: WordRow): number => {
    if (a.jmdict_sense_pos == null) return b.jmdict_sense_pos == null ? 0 : 1;
    if (b.jmdict_sense_pos == null) return -1;
    return a.jmdict_sense_pos - b.jmdict_sense_pos;
  };
  const byEntry = (a: WordRow, b: WordRow): number => {
    const ea = a.jmdict_entry_id ?? "", eb = b.jmdict_entry_id ?? "";
    return ea === eb ? 0 : ea < eb ? -1 : 1;
  };
  return [...rows].sort((a, b) => {
    if (reverseIntoJa) return bySensePos(a, b) || byEntry(a, b);
    // JA→EN: frequency DESC, NULLs last
    if (a.frequency == null !== (b.frequency == null)) return a.frequency == null ? 1 : -1;
    if (a.frequency != null && b.frequency != null && a.frequency !== b.frequency) {
      return b.frequency - a.frequency;
    }
    return byEntry(a, b) || bySensePos(a, b);
  });
}

/** All verified rows for many search terms in ONE query (the batch cache read).
 *  Matches `input` OR `input_reading` against the term list, like fetchVerified. */
async function fetchVerifiedMany(
  supabase: Supa,
  inputs: string[],
  sourceLang: string,
  targetLang: string,
): Promise<WordRow[]> {
  if (inputs.length === 0) return [];
  // Quote each term (see fetchVerified).
  const quote = (v: string) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  // CHUNK by encoded size: the list appears in the query string TWICE (input +
  // input_reading), and at ~9 bytes per encoded Japanese char a long paste built a URL
  // the runtime refused to send, throwing the whole batch. Hence `repeats: 2`.
  const chunks = chunkForUrlFilter(inputs, { repeats: 2 });
  const perChunk = await Promise.all(chunks.map(async (chunk) => {
    const list = chunk.map(quote).join(",");
    const { data, error } = await supabase
      .from("words")
      .select("*")
      .eq("source_lang", sourceLang)
      .eq("target_lang", targetLang)
      .eq("is_verified", true)
      .or(`input.in.(${list}),input_reading.in.(${list})`)
      .or(FRESH) // a stale projection is a MISS → re-projected in place
      // Same ranking as fetchVerified. Each term lands in ONE chunk, so a word's
      // senses are always ordered within their own query.
      .order("frequency", { ascending: false, nullsFirst: false })
      .order("jmdict_entry_id", { ascending: true, nullsFirst: false })
      .order("sense_rank", { ascending: true, nullsFirst: false });
    if (error) throw new Error(error.message);
    return (data ?? []) as WordRow[];
  }));
  // DEDUPE across chunks: the filter matches by `input` OR `input_reading`, so a text
  // using both 行く and いく as keys gets the same row back from two chunks, and
  // groupByInput would then render every sense twice. Belongs with the chunking — the
  // single-query version couldn't hit this.
  const seen = new Set<string>();
  return perChunk.flat().filter((row) => {
    if (seen.has(row.word_id)) return false;
    seen.add(row.word_id);
    return true;
  });
}

/**
 * REVIVE the MT rows for inputs the dictionary just failed to resolve — the piece that
 * lets MT rows be version-gated without a bump ever costing money (see FRESH above).
 *
 * The caller has already re-asked the dictionary for free. If it answered, we never get
 * here and the stale MT row just stops being served (dead storage — nothing is deleted,
 * so a `user_words` row pointing at it still resolves). If it still has nothing, this
 * re-stamps the row we already paid for and serves it, without calling Google.
 *
 * UPDATE … RETURNING, so it re-stamps and reads in one trip. Fails OPEN: the caller then
 * takes the normal paid path, which is correct-but-costly rather than wrong.
 */
async function reviveMtRows(
  supabase: Supa,
  inputs: string[],
  sourceLang: string,
  targetLang: string,
): Promise<WordRow[]> {
  if (inputs.length === 0) return [];
  // Chunked for the same URL-length reason as fetchVerifiedMany, but here the stakes are
  // money: a whole-list failure would silently re-pay Google for translated words.
  const chunks = chunkForUrlFilter(inputs.map((i) => `mt:${i}`));
  const perChunk = await Promise.all(chunks.map(async (refs) => {
    const { data, error } = await supabase
      .from("words")
      .update({ projection_version: CURRENT_PROJECTION_VERSION })
      .eq("source_lang", sourceLang)
      .eq("target_lang", targetLang)
      .eq("is_verified", true)
      .in("dictionary_ref", refs)
      .lt("projection_version", CURRENT_PROJECTION_VERSION)
      .select("*");
    if (error) {
      console.error("MT revive failed:", error.message);
      return []; // fails OPEN per chunk: the rest still revive
    }
    return (data ?? []) as WordRow[];
  }));
  return perChunk.flat();
}

// ── Idempotency (migration 20260626) ───────────────────────────────────────
// A retry of a request that already ran the PAID path must not re-call Google or
// re-reserve quota, so we replay the stored response for the client's key. Both helpers
// fail OPEN — a store blip just means the retry redoes the work.

/** Prior stored response for this key, or null (miss / disabled / error). */
async function lookupIdempotent(
  supabase: Supa,
  key: string | null,
): Promise<{ response: unknown; status: number } | null> {
  if (!key) return null;
  const { data, error } = await supabase
    .from("idempotency_keys")
    .select("response, status")
    .eq("key", key)
    .maybeSingle();
  if (error) {
    console.error("idempotency lookup failed:", error.message);
    return null;
  }
  return data ? { response: data.response, status: data.status } : null;
}

/** Persist a paid response under the key so a retry replays it. INSERT-or-do-nothing:
 *  a key's response is immutable (first write wins), so concurrent stores can't clobber. */
async function storeIdempotent(
  supabase: Supa,
  key: string,
  response: unknown,
  status: number,
): Promise<void> {
  const { error } = await supabase
    .from("idempotency_keys")
    .upsert({ key, response, status }, { onConflict: "key", ignoreDuplicates: true });
  if (error) console.error("idempotency store failed:", error.message);
}

/** The success response for a set of verified rows (primary = first). The single-word
 *  overrides reorder so the correct sense leads (前→まえ, ところ→所). */
function respondWords(input: string, rows: WordRow[]) {
  const words = orderSensesForInput(input, rows.map(toWord));
  return {
    translated: true,
    translation: words[0].translation,
    word: words[0],
    words,
  };
}

/** One per-input entry in a batch response. */
interface BatchEntry {
  input: string;
  translated: boolean;
  translation: string | null;
  word: ReturnType<typeof toWord> | null;
  words: ReturnType<typeof toWord>[];
}

/**
 * BATCH resolve: many cacheable words in ONE request, so the paragraph / add-many
 * fan-out costs one round-trip instead of N. Same per-word resolution as the single
 * path (cache → JMdict → metered MT), with the cache read and final upsert batched.
 * This is the WORD path; the paragraph gloss is its own `segments` mode.
 *
 * `dictionaryOnly` = cache + dictionary only, never MT — for callers that PROBE
 * speculative terms ("is 柔軟剤 a word?") rather than translating what a user asked for.
 * Probes are expected to MISS, and a miss is the answer, so billing Google for every
 * wrong guess (and caching the junk as verified) would be wrong, not just costly. It
 * also skips the MT revive, so a leftover MT row can't validate a probe for free.
 */
async function resolveBatch(
  supabase: Supa,
  rawInputs: unknown[],
  sourceLang: string,
  targetLang: string,
  authHeader: string | null,
  dictionaryOnly = false,
  /**
   * Skip the EN→JA reverse-gloss scan. ONLY for callers whose inputs are known to
   * resolve through WordNet, because the scan is what covers everything WordNet lacks.
   *
   * It exists because that scan is pathological on exactly the words a beginner meets.
   * Measured on prod 2026-08-07: jmdict_lookup EN→JA takes 5.0s for "one", 4.3s for
   * "back", 2.9s for "own" — all CEFR A1 — against ~0.2s for a B1 word, because a
   * frequent English word appears in a huge share of JMdict's glosses. Batched over a
   * whole draw that exceeds the statement timeout, and the Learn/placement quiz 500s.
   * The result: English placement worked at B1 and up but died at A1/A2 — the bands a
   * new learner starts in, so it read as "English testing isn't available".
   */
  skipGlossFallback = false,
): Promise<BatchEntry[]> {
  // IDEMPOTENCY: batch has no idempotency_keys entry — it relies on the `words` cache,
  // since each MT word is upserted so a retry hits the cache. The exposure is the narrow
  // window where MT ran but the upsert threw: a retry re-meters the uncached subset.
  // Accepted (rare, bounded by the per-word quota).
  // NFC-normalize + dedupe, preserving first-seen order.
  const inputs: string[] = [];
  const seen = new Set<string>();
  for (const raw of rawInputs) {
    const v = String(raw ?? "").trim().normalize("NFC");
    if (v && v.length <= MAX_INPUT_CHARS && !seen.has(v)) { seen.add(v); inputs.push(v); }
  }
  if (inputs.length === 0) return [];

  // 1. One batched cache read; the still-uncached terms need resolving.
  const cachedRows = await fetchVerifiedMany(supabase, inputs, sourceLang, targetLang);
  const cachedByInput = groupByInput(cachedRows, inputs);
  const missing = inputs.filter((i) => (cachedByInput.get(i) ?? []).length === 0);

  // 2. Resolve all misses in ONE batched RPC (two for EN→JA) regardless of miss count.
  const userId = userIdFromAuth(authHeader);
  const perInput: { input: string; results: ProviderResult[] }[] = [];
  const dictByInput = await resolveDictionaryMany(
    supabase, missing, sourceLang, targetLang, skipGlossFallback,
  );
  for (const input of missing) {
    const r = dictByInput.get(input);
    if (r && r.length > 0) perInput.push({ input, results: r });
  }

  // 3. MT fallback for what the dictionary missed — paid, so metered. The WHOLE batch's
  //    chars are reserved ONCE (per-user + global) rather than per word, so the app-wide
  //    global-quota lock is touched once per request; the unspent remainder is refunded.
  const canMT = mtConfigured() && !!userId && !dictionaryOnly;
  const stillMissing = missing.filter((i) => !dictByInput.has(i));

  // 3a. Revive before spending: a missing word may already have a PAID MT row the
  //     version gate marked stale. Re-stamp + reuse it; only a word with no MT row at
  //     all goes to Google. Skipped for probes (see `dictionaryOnly`).
  const revivedRows = dictionaryOnly
    ? []
    : await reviveMtRows(supabase, stillMissing, sourceLang, targetLang);
  const revived = new Set(revivedRows.map((r) => r.input));

  const needMT = stillMissing.filter((i) => !revived.has(i));
  if (canMT && needMT.length > 0) {
    const limits = await resolveLimits(supabase, userId!);
    // The per-request paragraph cap holds on the batch path too, and tokens that can't
    // be words at all are dropped (shouldSkipMt). Both BEFORE the reserve, so free.
    const mtWords = needMT.filter(
      (i) => i.length <= limits.paragraphCharLimit && !shouldSkipMt(i, sourceLang),
    );
    const skipped = needMT.length - mtWords.length;
    if (skipped > 0) console.log(JSON.stringify({ evt: "mt_skipped", n: skipped, path: "batch" }));
    const totalChars = mtWords.reduce((n, w) => n + w.length, 0);
    if (totalChars > 0) {
      const reserve = await reserveQuota(supabase, userId!, totalChars, limits.monthlyCharQuota);
      const globalOk = reserve.allowed && (await reserveGlobalQuota(supabase, totalChars, globalCharQuota()));
      if (reserve.committed && !globalOk) await refundQuota(supabase, userId!, totalChars); // global denied → undo per-user
      if (reserve.allowed && globalOk) {
        // CONCURRENTLY, in bounded waves. This loop used to be strictly serial — one
        // round-trip to Google per word — which is invisible on prod (the full JMdict
        // resolves nearly everything, so few words get here) but pathological anywhere
        // the dictionary is thinner: against the `common` JMdict subset a single
        // English article misses dozens of words, and the serial walk ran past the
        // local edge runtime's wall clock, so the request never returned at all and the
        // reader just spun. Nothing about the metering changes — the whole batch's
        // chars are already reserved once, above, and refunded below.
        let spent = 0;
        for (let i = 0; i < mtWords.length; i += MT_CONCURRENCY) {
          const wave = mtWords.slice(i, i + MT_CONCURRENCY);
          const got = await Promise.all(
            wave.map(async (w) => ({ w, mt: await callTranslationProvider(w, sourceLang, targetLang) })),
          );
          for (const { w, mt } of got) {
            if (mt) { perInput.push({ input: w, results: [mt] }); spent += w.length; }
          }
        }
        // Refund the reserved-but-unspent chars; per-user only if the reserve committed.
        const unspent = totalChars - spent;
        if (unspent > 0) {
          if (reserve.committed) await refundQuota(supabase, userId!, unspent);
          await refundGlobalQuota(supabase, unspent);
        }
      }
    }
  }

  // Before projection, so both the upsert and the refToTerms mapping see the overrides.
  await applyEnglishFrequency(supabase, perInput, sourceLang, targetLang);
  await applyEnglishProficiency(supabase, perInput, sourceLang, targetLang);
  await applySenseExamples(supabase, perInput, sourceLang, targetLang);

  // 3. One upsert for every freshly-projected sense (deduped by dictionary_ref).
  let savedRows: WordRow[] = [];
  if (perInput.length > 0) {
    const rows = projectMany(perInput, sourceLang, targetLang, CURRENT_PROJECTION_VERSION);
    const { data, error } = await supabase
      .from("words")
      .upsert(rows, { onConflict: "dictionary_ref,source_lang,target_lang" })
      .select("*");
    if (error) throw new Error(error.message);
    savedRows = (data ?? []) as WordRow[];
  }

  // 4. Map rows back to each SEARCH term. Cache hits (and revived MT rows) match by
  //    headword/reading; freshly-resolved rows map by dictionary_ref to the term that
  //    produced them, which is what covers WRITING VARIANTS — 速い is stored under
  //    headword 早い, so neither its headword nor its reading equals the search term and
  //    groupByInput alone would drop it.
  const cachedByTerm = groupByInput([...cachedRows, ...revivedRows], inputs);
  const refToTerms = new Map<string, string[]>();
  for (const { input, results } of perInput) {
    for (const r of projectRows(results, input, sourceLang, targetLang, CURRENT_PROJECTION_VERSION)) {
      const terms = refToTerms.get(r.dictionary_ref);
      if (terms) { if (!terms.includes(input)) terms.push(input); }
      else refToTerms.set(r.dictionary_ref, [input]);
    }
  }
  const savedByTerm = new Map<string, WordRow[]>();
  for (const row of savedRows) {
    for (const term of refToTerms.get(row.dictionary_ref) ?? []) {
      const list = savedByTerm.get(term);
      if (list) list.push(row);
      else savedByTerm.set(term, [row]);
    }
  }
  const bySensePos = (a: WordRow, b: WordRow) => {
    const ap = a.jmdict_sense_pos, bp = b.jmdict_sense_pos;
    if (ap == null) return bp == null ? 0 : 1; // nulls last
    if (bp == null) return -1;
    return ap - bp;
  };
  return inputs.map((input) => {
    // An input is either a cache hit OR a miss (never both — see `missing`), so the two
    // sources don't overlap; combine, order primary-first, then apply the override.
    const ws = [...(cachedByTerm.get(input) ?? []), ...(savedByTerm.get(input) ?? [])].sort(bySensePos);
    if (ws.length === 0) return { input, translated: false, translation: null, word: null, words: [] };
    const words = orderSensesForInput(input, ws.map(toWord));
    return { input, translated: true, translation: words[0].translation, word: words[0], words };
  });
}

// ── Level-based new-words quiz (Proficiency.md feature 2) ───────────────────

/** Unseen headwords at proficiency `band` for the caller. The SQL owns the source
 *  (JMdict for JA→EN, english_proficiency + WordNet for EN→JA; migrations 20260717 /
 *  20260745); empty for a pair with no curated wordlist. */
async function selectLearnHeadwords(
  supabase: Supa,
  sourceLang: string,
  targetLang: string,
  band: number,
  userId: string | null,
  limit: number,
  excludeSeen: boolean,
): Promise<string[]> {
  const { data, error } = await supabase.rpc("learn_words_at_band", {
    p_source: sourceLang,
    p_target: targetLang,
    p_band: band,
    p_user_id: userId,
    p_limit: limit,
    p_exclude_seen: excludeSeen,
  });
  if (error) throw new Error(error.message);
  return (data ?? []).map((r: { headword: string }) => r.headword);
}

// Best-effort append to the admin error_log (migration 20260706). NEVER throws — a
// logging failure must not change the request outcome. Input is truncated so a huge
// paragraph can't bloat the log.
async function recordError(
  supabase: Supa,
  params: { code: string; source: string; userId?: string | null; input?: string | null; detail?: string | null },
): Promise<void> {
  try {
    await supabase.from("error_log").insert({
      error_code: params.code,
      source: params.source,
      user_id: params.userId ?? null,
      input: params.input ? params.input.slice(0, 500) : null,
      detail: params.detail ? params.detail.slice(0, 1000) : null,
    });
  } catch (_e) {
    // swallow — never break the response over a logging failure
  }
}

// HTTP handler. Responds { translated, translation, word, words } (word = the primary
// sense, kept for back-compat) or { error } + 4xx/5xx. POST only (+ OPTIONS/CORS);
// requires input/sourceLang/targetLang; rejects source == target; persist=false skips
// the cache entirely.
async function handleRequest(req: Request): Promise<Response> {
  const cors = corsHeaders(
    req.headers.get("Origin"),
    parseAllowedOrigins(Deno.env.get("ALLOWED_ORIGINS")),
  );
  const reply = (body: unknown, status = 200) => json(body, status, cors);

  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  // A GET is a cheap liveness probe — no DB or provider call, never spends.
  if (req.method === "GET") return reply({ status: "ok" }, 200);
  if (req.method !== "POST") return reply({ error: "Method not allowed" }, 405);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return reply({ error: "Invalid JSON body" }, 400);
  }
  const sourceLang = String(body.sourceLang ?? "");
  const targetLang = String(body.targetLang ?? "");
  if (!sourceLang || !targetLang) {
    return reply({ error: "sourceLang and targetLang are required" }, 400);
  }
  if (sourceLang === targetLang) {
    return reply({ error: "Source and target language are the same" }, 400);
  }

  // BATCH mode: { inputs: string[] } resolves many cacheable words in ONE request.
  if (Array.isArray(body.inputs)) {
    try {
      const results = await resolveBatch(
        supabase, body.inputs, sourceLang, targetLang, req.headers.get("Authorization"),
        body.dictionaryOnly === true,
      );
      return reply({ results });
    } catch (e) {
      console.error("batch resolve failed:", e); // detail server-side only
      await recordError(supabase, {
        code: "translate_batch_failed",
        source: "translate.batch",
        userId: userIdFromAuth(req.headers.get("Authorization")),
        input: Array.isArray(body.inputs) ? body.inputs.slice(0, 10).join(", ") : null,
        detail: e instanceof Error ? e.message : String(e),
      });
      return reply({ error: "Translation failed" }, 500); // generic — no schema/SQL leak
    }
  }

  // LEARN mode: { learn: { band, limit? } } → up to `limit` UNSEEN words at that band,
  // returned as quiz cards (one card = a word's full sense list, primary first). The
  // retrieval reads the server-only wordlists, since the `words` cache is incomplete;
  // resolveBatch then projects + groups them like a paragraph's new words.
  if (body.learn && typeof body.learn === "object") {
    const parsed = parseLearnRequest(body.learn as { band?: unknown; limit?: unknown; excludeSeen?: unknown });
    if (!parsed.ok) return reply({ error: parsed.error }, 400);
    const { band, limit, excludeSeen } = parsed;
    const userId = userIdFromAuth(req.headers.get("Authorization"));
    try {
      const headwords = await selectLearnHeadwords(supabase, sourceLang, targetLang, band, userId, limit, excludeSeen);
      if (headwords.length === 0) return reply({ cards: [] });
      // Every headword comes from a source we can already translate, so these resolve
      // without the paid MT path — and for EN→JA the pool itself only emits surfaces
      // that HAVE a Japanese WordNet side (migration 20260745 gates on
      // `wordnet_senses_en JOIN wordnet_words_ja`), so the reverse-gloss fallback can
      // add nothing here and is skipped. That is what keeps the beginner bands inside
      // the statement timeout; see resolveBatch's `skipGlossFallback`. Measured: 0
      // multi-word candidates at A1/A2/B1, so nothing depends on the fallback.
      const entries = await resolveBatch(
        supabase, headwords, sourceLang, targetLang, req.headers.get("Authorization"),
        false, true,
      );
      const cards = entries
        .filter((e) => e.translated && e.words.length > 0)
        .map((e) => e.words);
      return reply({ cards });
    } catch (e) {
      console.error("learn resolve failed:", e); // detail server-side only
      await recordError(supabase, {
        code: "learn_failed",
        source: "translate.learn",
        userId,
        detail: e instanceof Error ? e.message : String(e),
      });
      return reply({ error: "Could not load words" }, 500); // generic — no schema/SQL leak
    }
  }

  // SEGMENTS mode: one gloss per segment, index-aligned, so the reader can print the
  // English UNDER each Japanese sentence. Always DISPLAY-ONLY — we don't store thousands
  // of unique sentences — so it skips the dictionary path and goes to the metered MT gate.
  if (Array.isArray(body.segments)) {
    // Bound the fan-out BEFORE walking the array.
    if (body.segments.length > MAX_SEGMENTS) {
      return reply(
        { error: `Too many segments (max ${MAX_SEGMENTS})`, limit: MAX_SEGMENTS, count: body.segments.length },
        413,
      );
    }
    const prepared = prepareSegments(body.segments);
    const idempotencyKey =
      typeof body.idempotencyKey === "string" && body.idempotencyKey ? body.idempotencyKey : null;
    const blank = () => reply({ glosses: prepared.normalized.map(() => null) });

    // Same unmetered-scan guard as SINGLE mode, applied to the whole request.
    if (prepared.chars > MAX_INPUT_CHARS) {
      return reply(
        { error: `Input exceeds the ${MAX_INPUT_CHARS}-character limit`, limit: MAX_INPUT_CHARS, length: prepared.chars },
        413,
      );
    }
    if (prepared.unique.length === 0) return blank();

    const userId = userIdFromAuth(req.headers.get("Authorization"));
    // Never spend on a request we can't meter.
    if (!mtConfigured() || !userId) return blank();

    const prior = await lookupIdempotent(supabase, idempotencyKey);
    if (prior) return reply(prior.response, prior.status);

    const { paragraphCharLimit, monthlyCharQuota } = await resolveLimits(supabase, userId);
    // The segments ARE one paragraph, so the per-request cap applies to their sum —
    // otherwise splitting a paragraph would be a way around the limit.
    if (prepared.chars > paragraphCharLimit) {
      return reply(
        {
          error: `Input exceeds the ${paragraphCharLimit}-character translation limit`,
          limit: paragraphCharLimit,
          length: prepared.chars,
        },
        413,
      );
    }
    // Reserve the DEDUPED char count before the paid call, per-user then global.
    const { allowed, used, committed } = await reserveQuota(
      supabase, userId, prepared.chars, monthlyCharQuota,
    );
    if (!allowed) {
      return reply({ error: "Monthly translation quota reached", used, quota: monthlyCharQuota }, 429);
    }
    const gQuota = globalCharQuota();
    if (!(await reserveGlobalQuota(supabase, prepared.chars, gQuota))) {
      if (committed) await refundQuota(supabase, userId, prepared.chars);
      console.error(JSON.stringify({ evt: "global_cap_reached", quota: gQuota }));
      return reply({ error: "Service translation quota reached, try again later", quota: gQuota }, 429);
    }

    const translated = await callTranslationProviderMany(prepared.unique, sourceLang, targetLang);
    if (!translated) {
      // Provider spent nothing — refund both.
      if (committed) await refundQuota(supabase, userId, prepared.chars);
      await refundGlobalQuota(supabase, prepared.chars);
    }
    const resBody = { glosses: expandSegmentResults(prepared, translated) };
    // The paid path ran, so a retry replays this instead of re-spending.
    if (idempotencyKey && translated) await storeIdempotent(supabase, idempotencyKey, resBody, 200);
    return reply(resBody);
  }

  // SINGLE mode: { input, persist?, idempotencyKey? }. NFC to match the cache key.
  // (EN inflection is lemmatized inside resolveDictionary, so the key stays the surface.)
  const input = String(body.input ?? "").trim().normalize("NFC");
  // persist=false → display only, no cache read or write (we don't store paragraphs).
  const persist = body.persist !== false;
  const idempotencyKey =
    typeof body.idempotencyKey === "string" && body.idempotencyKey ? body.idempotencyKey : null;
  if (!input) {
    return reply({ error: "input, sourceLang and targetLang are required" }, 400);
  }
  // Hard cap BEFORE the cache/dictionary lookup — bounds the unmetered scan path.
  if (input.length > MAX_INPUT_CHARS) {
    return reply(
      { error: `Input exceeds the ${MAX_INPUT_CHARS}-character limit`, limit: MAX_INPUT_CHARS, length: input.length },
      413,
    );
  }

  // 0. Idempotency replay: a retried PAID request already has its response stored.
  const prior = await lookupIdempotent(supabase, idempotencyKey);
  if (prior) return reply(prior.response, prior.status);

  // Only a request that ran the PAID path stores its response, so a retry replays it.
  let usedMT = false;
  const finish = async (resBody: unknown, status = 200) => {
    if (idempotencyKey && usedMT) await storeIdempotent(supabase, idempotencyKey, resBody, status);
    return reply(resBody, status);
  };

  // A GRAMMATICAL word is terminal, decided BEFORE the cache read — otherwise a leftover
  // paid `mt:an` row answers and every guard below is unreachable. Terminal means the
  // cache, the dictionary and MT are all skipped; the dead row stops being served.
  // (A multi-word PHRASE deliberately does NOT stop here — MT is the right answer for
  // it, and the client sends whole native-language sentences down this same path.)
  if (sourceLang === "EN" && targetLang === "JA" && isEnglishFunctionWord(input)) {
    return reply({ translated: false, translation: null, word: null, words: [] });
  }

  // 1. Verified-cache check (all senses). Only an EXACT-HEADWORD match is a complete
  //    hit: a reading-only match (こと finding the cached 琴) may be PARTIAL, since a
  //    homophone like 事 might never have been cached — so fall through to the full
  //    lookup, which projects the whole set.
  if (persist) {
    const cached = await fetchVerified(supabase, input, sourceLang, targetLang);
    if (cached.some((r) => r.input === input)) return reply(respondWords(input, cached));
  }

  // 2. Resolve senses: JMdict first, then the MT fallback. The paid path runs ONLY when
  //    MT is configured AND the request is attributable to a user (a JWT `sub`) — an
  //    anon-key call can't be metered, so it must not spend. (Guests are real
  //    anonymous-auth users, so they always have a sub.)
  const userId = userIdFromAuth(req.headers.get("Authorization"));
  let results = await resolveDictionary(supabase, input, sourceLang, targetLang);

  // 2a. The dictionary has nothing, but a PAID MT row may exist that the version gate
  //     treated as stale. Re-stamp and serve it rather than buying the same text again.
  if (persist && results.length === 0) {
    const revived = await reviveMtRows(supabase, [input], sourceLang, targetLang);
    if (revived.length > 0) return reply(respondWords(input, revived));
  }

  // A token that can't be a word in the source language never reaches the paid provider.
  // Checked before the limits below, so it reserves nothing and comes back unresolved.
  if (results.length === 0 && persist && shouldSkipMt(input, sourceLang)) {
    console.log(JSON.stringify({ evt: "mt_skipped", n: 1, path: "word" }));
    return finish({ translated: false, translation: null, word: null, words: [] });
  }

  if (results.length === 0 && mtConfigured() && userId) {
    // MT is the only PAID path → the hard server-side limits gate (the client also
    // pre-checks for UX). Both checks run BEFORE the call, so a rejection costs nothing.
    const { paragraphCharLimit, monthlyCharQuota } = await resolveLimits(supabase, userId);

    // (a) per-request paragraph cap → 413
    if (input.length > paragraphCharLimit) {
      return reply(
        {
          error: `Input exceeds the ${paragraphCharLimit}-character translation limit`,
          limit: paragraphCharLimit,
          length: input.length,
        },
        413,
      );
    }
    // (b) cumulative MONTHLY quota → 429. Reserved ATOMICALLY before the paid call
    //     (no check-then-meter race); a denied reservation costs nothing.
    const { allowed, used, committed } = await reserveQuota(
      supabase, userId, input.length, monthlyCharQuota,
    );
    if (!allowed) {
      return reply(
        { error: "Monthly translation quota reached", used, quota: monthlyCharQuota },
        429,
      );
    }

    // (c) GLOBAL monthly cap across ALL users → 429.
    const gQuota = globalCharQuota();
    const ok = await reserveGlobalQuota(supabase, input.length, gQuota);
    if (!ok) {
      // Refund only if the reserve actually committed — a fail-open reserve added
      // nothing, so refunding it would erase legitimate prior usage.
      if (committed) await refundQuota(supabase, userId, input.length);
      console.error(JSON.stringify({ evt: "global_cap_reached", quota: gQuota }));
      return reply({ error: "Service translation quota reached, try again later", quota: gQuota }, 429);
    }

    // The paid path ran, so the response is stored under the idempotency key.
    usedMT = true;
    const mt = await callTranslationProvider(input, sourceLang, targetLang);
    if (mt) {
      results = [mt];
    } else {
      // Google spent nothing — refund both (per-user only if it committed).
      if (committed) await refundQuota(supabase, userId, input.length);
      await refundGlobalQuota(supabase, input.length);
    }
  }
  if (results.length === 0) {
    return finish({ translated: false, translation: null, word: null, words: [] });
  }

  // 3. Display-only (paragraph): return the primary text without caching. A name MT
  //    only romanized (父島 → "Chichijima") takes the same exit: the asker still gets
  //    their answer, but it never becomes a verified row or a card to study.
  if (!persist || (usedMT && isRomanizedName(results[0].translation, sourceLang, targetLang))) {
    return finish({
      translated: true,
      translation: results[0].translation,
      word: null,
      words: [],
    });
  }

  await applyEnglishFrequency(supabase, [{ input, results }], sourceLang, targetLang);
  await applyEnglishProficiency(supabase, [{ input, results }], sourceLang, targetLang);
  await applySenseExamples(supabase, [{ input, results }], sourceLang, targetLang);

  // 4. Persist every sense as a verified global word (service role bypasses RLS).
  //    projectRows handles the headword, the dedupe and the stable dictionary_ref.
  const rows = projectRows(results, input, sourceLang, targetLang, CURRENT_PROJECTION_VERSION);
  // upsert().select() returns the written rows inline — no second read round-trip. The
  // cache was empty, so these ARE the full verified set for `input`.
  const { data: saved, error: insertError } = await supabase
    .from("words")
    .upsert(rows, { onConflict: "dictionary_ref,source_lang,target_lang" })
    .select("*");
  if (insertError) {
    console.error("words upsert failed:", insertError.message); // detail server-side only
    await recordError(supabase, {
      code: insertError.code ?? "words_upsert_failed",
      source: "translate.single",
      userId,
      input,
      detail: insertError.message,
    });
    // finish(), not reply(): if MT already spent, a retry must replay this 500 rather
    // than re-reserving quota and re-calling Google.
    return finish({ error: "Translation failed" }, 500); // generic — no schema/SQL leak
  }

  const ordered = sortBySensePos((saved ?? []) as WordRow[], isReverseIntoJa(sourceLang, targetLang));
  return reply(ordered.length > 0 ? respondWords(input, ordered) : {
    translated: true,
    translation: results[0].translation,
    word: null,
    words: [],
  });
}

// Entry point: one structured access-log line per request (method, status, duration);
// a 5xx also logs as an error so it surfaces in alerting. Errors never escape — a thrown
// handler becomes a logged 500 — so a bug can't take the function down silently.
Deno.serve(async (req) => {
  const start = Date.now();
  let res: Response;
  try {
    res = await handleRequest(req);
  } catch (e) {
    console.error("translate handler crashed:", e);
    try {
      await recordError(supabase, {
        code: "translate_handler_crashed",
        source: "translate.handler",
        userId: userIdFromAuth(req.headers.get("Authorization")),
        detail: e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e),
      });
    } catch (_e) { /* swallow */ }
    res = json({ error: "Internal error" }, 500);
  }
  const line = JSON.stringify({
    evt: "request",
    method: req.method,
    status: res.status,
    ms: Date.now() - start,
  });
  if (res.status >= 500) console.error(line);
  else console.log(line);
  return res;
});
