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
//   2. Miss -> jmdict_lookup(); fall back to the Google MT provider.
//   3. No result -> { translated: false, ... }.
//   4. Success -> upsert verified words (readings ride inline on each row) and return.
//
// READINGS: each `words` row carries input_reading / translation_reading inline.
// That is the furigana source for the no-context surface (single-word lookups,
// flashcards), where kuromoji is unreliable. Sentence furigana uses client-side
// kuromoji (context-aware). There is NO separate readings table.
//
// MT FALLBACK: callTranslationProvider() calls Google Cloud Translation v2 when
// JMdict has no match — covering words JMdict lacks and the whole-paragraph
// display gloss (persist:false). It degrades to null (no result) when the API
// key is absent or the call fails, so JMdict-only operation is unaffected.
//
// Required env: the auto-provided SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.
// Optional secrets: TRANSLATION_API_KEY (enables MT), TRANSLATION_API_URL
// (overrides the Google v2 endpoint, e.g. for a proxy/mock).
//
// CROSS-RUNTIME MIRROR: toWord() and the upsert onConflict tuple hand-mirror
// src/services/words/repository.ts (separate Deno runtime) — keep them in sync.
// =========================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
// Pure helpers live in _lib.ts so they're unit-testable from the Node/Vitest
// suite (this Deno file can't be imported there). See tests/edge/translate-lib.test.ts.
import {
  corsHeaders,
  groupByInput,
  lemmaCandidates,
  parseAllowedOrigins,
  projectMany,
  projectRows,
  resolvePerInputWithCandidates,
  resolveServiceKey,
  toGoogleLang,
  userIdFromAuth,
  type ProviderResult,
} from "./_lib.ts";

// Stamp written onto every projected `words` row (projection_version). BUMP this
// whenever the source data (a JMdict re-ingest) or the projection logic
// (jmdict_lookup / the toWord projection below — readings, headword, uk, ranking,
// dictionary_ref) changes, so the deferred (#5) re-projection sweep can find
// rows it must rebuild (those with projection_version < this).
//   1 = pre-stable-identity baseline (no dictionary_ref)
//   2 = stable JMdict identity (#1: jmdict_entry_id/sense_pos + dictionary_ref)
//   3 = #7: frequency + part_of_speech projected; frequency-ranked ordering
//   4 = WordNet-first EN->JA: synset-grouped senses (re-ranked sensePos) replace
//       the raw reverse-gloss order; JA->EN rows are unaffected but re-stamped.
const CURRENT_PROJECTION_VERSION = 4;

// Service-role credentials. Prefer an explicit secret (SERVICE_ROLE_SECRET, a new
// `sb_secret_…` key) over the auto-injected legacy SUPABASE_SERVICE_ROLE_KEY, so the
// function keeps full RLS-bypass access after the legacy API keys are disabled
// (key-rotation remediation). Falls back to the legacy key when the secret is unset.
const SB_URL = Deno.env.get("SUPABASE_URL")!;
// resolveServiceKey (in _lib.ts, unit-tested) handles the secret→legacy precedence
// and the empty-string fallback.
const SERVICE_KEY = resolveServiceKey({
  SERVICE_ROLE_SECRET: Deno.env.get("SERVICE_ROLE_SECRET"),
  SUPABASE_SERVICE_ROLE_KEY: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
})!;
// One service-role client for the whole isolate (supabase-js is fetch-based and
// stateless here) — no need to reconstruct it per request on the hot path.
const supabase = createClient(SB_URL, SERVICE_KEY);

// corsHeaders(origin, allowedOrigins) is in _lib.ts (ALLOWED_ORIGINS env → echo a
// listed Origin, else "*" in dev). NOTE: the local `supabase start` Kong gateway
// rewrites the response header to "*"; the function's value is authoritative only
// in production.

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
  difficulty_override: number | null;
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
    partOfSpeech: r.part_of_speech ?? null,
    frequency: r.frequency ?? null,
    difficultyOverride: r.difficulty_override ?? null,
    jmdictEntryId: r.jmdict_entry_id ?? null,
    jmdictSensePos: r.jmdict_sense_pos ?? null,
    isVerified: r.is_verified,
  };
}

// ProviderResult (one projected sense) is defined in _lib.ts and imported above.

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
    frequency: number | null;
    part_of_speech: string[] | null;
  }) => ({
    translation: row.translation,
    inputReading: row.input_reading ?? null,
    translationReading: row.translation_reading ?? null,
    headword: row.writing ?? null,
    entryId: row.jmdict_entry_id ?? null,
    sensePos: row.sense_position ?? null,
    frequency: row.frequency ?? null,
    partOfSpeech: row.part_of_speech ?? null,
  }));
}

// EN->JA is the slow direction (WordNet + reverse-gloss + projecting/upserting each
// row), and its long tail is the noisiest (acronym/mid-gloss matches). Cap it tighter
// than the SQL ceiling for performance — the client only shows 8 before "show more"
// anyway, and EN->JA rarely has 8+ good senses. (JA->EN is capped by jmdict_lookup's
// own LIMIT 12.) Bumping this needs no client change. See docs/TODO.md.
const EN_JA_RESULT_LIMIT = 8;

// Resolve a lookup to its dictionary senses. EN->JA leads with the SEMANTIC
// WordNet results and falls back to the reverse-gloss jmdict_lookup only to fill
// the remaining slots (coverage for words WordNet lacks) — skipping the gloss
// query entirely when WordNet already fills the cap. Every other direction is
// straight jmdict_lookup. The MT fallback (caller's job) still runs only when this
// returns [].
async function resolveDictionary(
  supabase: Supa,
  input: string,
  sourceLang: string,
  targetLang: string,
): Promise<ProviderResult[]> {
  if (sourceLang === "EN" && targetLang === "JA") {
    // Lemmatize via WordNet-morphy candidates (cats→cat, ran→run), resolved in just TWO
    // parallel round-trips — same union-query + first-hit machinery as the batch path
    // (no sequential per-candidate queries). The helper tries the SURFACE form first,
    // reuses the winning lemma for the gloss fallback, and drops off-script romaji noise
    // (ＰＥＮ/ＢＩＳ). sensePos is renumbered in the merge so the cache-read ORDER BY stays
    // deterministic. (Gloss runs even when WordNet fills the cap — it's parallel, so no
    // added latency, and the merge ignores the surplus.)
    const candidates = lemmaCandidates(input, sourceLang);
    const [wnRows, glossRows] = await Promise.all([
      lookupWordNetMany(supabase, candidates),
      lookupJMdictMany(supabase, candidates, sourceLang, targetLang),
    ]);
    const resolved = resolvePerInputWithCandidates(
      [input],
      new Map([[input, candidates]]),
      groupProviderByInput(wnRows),
      groupProviderByInput(glossRows),
      targetLang,
      EN_JA_RESULT_LIMIT,
    );
    return resolved.get(input) ?? [];
  }
  return lookupJMdict(supabase, input, sourceLang, targetLang);
}

// One DB row from a (single or _many) lookup function → a ProviderResult. Shared by
// the single + batch lookups (identical projection).
type LookupRow = {
  translation: string;
  input_reading: string | null;
  translation_reading: string | null;
  writing: string | null;
  sense_position: number | null;
  jmdict_entry_id: string | null;
  frequency: number | null;
  part_of_speech: string[] | null;
};
function rowToProvider(row: LookupRow): ProviderResult {
  return {
    translation: row.translation,
    inputReading: row.input_reading ?? null,
    translationReading: row.translation_reading ?? null,
    headword: row.writing ?? null,
    entryId: row.jmdict_entry_id ?? null,
    sensePos: row.sense_position ?? null,
    frequency: row.frequency ?? null,
    partOfSpeech: row.part_of_speech ?? null,
  };
}

// BATCH dictionary lookups: resolve MANY inputs in ONE RPC (cold-paragraph N+1 fix,
// migration 20260710). Each returns rows tagged with the search `input` so callers can
// regroup per term. These are the ONLY lookup entry points (single-word resolves a
// 1-element batch too). WordNet = the SEMANTIC EN->JA provider (English lemma -> synsets
// -> the Japanese lemmas in each, resolved through JMdict for reading/frequency/POS,
// ordered by WordNet sense rank; EN->JA only). JMdict = the reverse-gloss/direct lookup.
async function lookupJMdictMany(
  supabase: Supa, inputs: string[], sourceLang: string, targetLang: string,
): Promise<{ input: string; r: ProviderResult }[]> {
  const { data, error } = await supabase.rpc("jmdict_lookup_many", {
    p_inputs: inputs, p_source: sourceLang, p_target: targetLang,
  });
  if (error) throw new Error(error.message);
  return (data ?? []).map((row: LookupRow & { input: string }) => ({ input: row.input, r: rowToProvider(row) }));
}
async function lookupWordNetMany(
  supabase: Supa, inputs: string[],
): Promise<{ input: string; r: ProviderResult }[]> {
  const { data, error } = await supabase.rpc("wordnet_en_ja_lookup_many", { p_inputs: inputs });
  if (error) throw new Error(error.message);
  return (data ?? []).map((row: LookupRow & { input: string }) => ({ input: row.input, r: rowToProvider(row) }));
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
): Promise<Map<string, ProviderResult[]>> {
  if (inputs.length === 0) return new Map();
  const out = new Map<string, ProviderResult[]>();
  if (sourceLang === "EN" && targetLang === "JA") {
    // Lemmatize like the single-word path, but in ONE round-trip: expand every token to
    // its lemma candidates and query WordNet + the gloss fallback over the UNION, then
    // pick each token's winning lemma and re-key the senses to the surface token. So a
    // paragraph of inflected English (cats, ran, studies) reads as well as single words.
    const candsByInput = new Map(inputs.map((i) => [i, lemmaCandidates(i, sourceLang)] as const));
    const allCands = [...new Set([...candsByInput.values()].flat())];
    const [wnRows, glossRows] = await Promise.all([
      lookupWordNetMany(supabase, allCands),
      lookupJMdictMany(supabase, allCands, sourceLang, targetLang),
    ]);
    const wnByCand = groupProviderByInput(wnRows);
    const glossByCand = groupProviderByInput(glossRows);
    for (const [input, results] of resolvePerInputWithCandidates(
      inputs, candsByInput, wnByCand, glossByCand, targetLang, EN_JA_RESULT_LIMIT,
    )) {
      out.set(input, results);
    }
  } else {
    const by = groupProviderByInput(await lookupJMdictMany(supabase, inputs, sourceLang, targetLang));
    for (const input of inputs) {
      const r = by.get(input) ?? [];
      if (r.length > 0) out.set(input, r);
    }
  }
  return out;
}

// Google Cloud Translation API v2 endpoint (REST, API-key auth). Overridable via
// TRANSLATION_API_URL (e.g. to point at a proxy or a mock in tests).
const DEFAULT_TRANSLATION_API_URL =
  "https://translation.googleapis.com/language/translate/v2";

// toGoogleLang(lang) is in _lib.ts (App JA/EN/KO/ZH → Google ISO codes).

// MT FALLBACK — Google Cloud Translation v2. Invoked only when JMdict has no
// match: covers words JMdict lacks AND the whole-paragraph display gloss
// (persist:false). Provider-agnostic secret names (TRANSLATION_API_KEY /
// _API_URL) so swapping providers is a body change here, nothing else.
//
// Degrades to null (→ caller returns "no result") on EVERY failure mode —
// missing key, non-2xx, network error, empty payload — so a flaky/unconfigured
// MT never 500s the request or breaks the per-word paragraph fan-out. Readings
// are JMdict-only, so an MT result carries none (the no-context furigana surface
// simply has nothing to show for these).
async function callTranslationProvider(
  text: string,
  sourceLang: string,
  targetLang: string,
): Promise<ProviderResult | null> {
  const key = Deno.env.get("TRANSLATION_API_KEY");
  if (!key) return null; // not configured → behaves like the old no-MT stub

  const url = Deno.env.get("TRANSLATION_API_URL") ?? DEFAULT_TRANSLATION_API_URL;
  try {
    const res = await fetch(`${url}?key=${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        q: text,
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
    const translated: string | undefined =
      body?.data?.translations?.[0]?.translatedText;
    // MT-SPEND METRIC (#8 observability): one structured line per PAID Google call,
    // so spend = sum(mt_chars) over these logs. Drives the MT-spend dashboard/alert.
    console.log(JSON.stringify({
      evt: "mt_spend",
      mt_chars: text.length,
      source: toGoogleLang(sourceLang),
      target: toGoogleLang(targetLang),
      ok: Boolean(translated),
    }));
    return translated ? { translation: translated } : null;
  } catch (e) {
    console.error("MT provider request failed:", e);
    return null;
  }
}

// ── Per-user RESTRICTIONS (the limits subsystem; see migration 20260620 +
// services/entitlements.ts) ────────────────────────────────────────────────
// The MT call is the only PAID path, so limits are enforced HERE (the hard gate
// the client can't bypass): a PER-REQUEST paragraph char cap AND a cumulative
// MONTHLY character quota (the free-tier ceiling). Both resolve from the caller's
// `user_limits` override → else env → else the built-in default. Keep these
// defaults in sync with DEFAULT_LIMITS in services/entitlements.ts.
const DEFAULT_PARAGRAPH_CHAR_LIMIT = 2000;
const DEFAULT_MONTHLY_CHAR_QUOTA = 450_000;
// Hard ceiling enforced BEFORE any dictionary lookup (the per-user paragraph limit
// only gates the paid MT path), so a pathological input can't hit the unmetered
// JMdict/WordNet scan. Generous — well above any per-user paragraph limit.
const MAX_INPUT_CHARS = 20_000;

// userIdFromAuth(authHeader) is in _lib.ts (JWT `sub`, or null).

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
 * ATOMICALLY reserve `chars` of the user's monthly quota (check + meter in one
 * locked RPC — no check-then-meter race). Returns whether the call is allowed and
 * the month-to-date total. Fails OPEN (allowed) on an RPC error so a transient DB
 * blip doesn't break translation — the cap is a free-tier guard, not hard billing.
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
  // `committed` = chars were actually added (only when allowed AND no error), so a
  // later refund doesn't decrement legitimate usage after a fail-open / a denial.
  return { allowed, used: row?.used ?? 0, committed: allowed };
}

// ── Global cost controls (#1) ───────────────────────────────────────────────
// EMERGENCY KILL-SWITCH: set the MT_DISABLED secret to instantly stop ALL paid
// Google calls (the app degrades to JMdict-only) WITHOUT a redeploy. Checked before
// any quota reserve or provider call, so a flipped switch costs nothing.
function mtDisabled(): boolean {
  const v = (Deno.env.get("MT_DISABLED") ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

// The paid MT path runs ONLY when MT is configured: a key is present AND the
// kill-switch is off. Gating on this (not just inside callTranslationProvider)
// means an unconfigured/disabled MT never reserves quota — no phantom spend, no
// quota burned on a call that can't happen.
function mtConfigured(): boolean {
  return !mtDisabled() && !!Deno.env.get("TRANSLATION_API_KEY");
}

// GLOBAL monthly char cap across ALL users (the aggregate billing risk the per-user
// quota can't bound). Always finite: a generous BUILT-IN default applies when the
// env override is unset, so the aggregate spend is never fully unbounded by default
// (the deploy can lower it). ≈$30/mo worst case at Google rates.
const DEFAULT_GLOBAL_MONTHLY_CHAR_QUOTA = 2_000_000;
function globalCharQuota(): number {
  const v = Number(Deno.env.get("GLOBAL_MONTHLY_CHAR_QUOTA"));
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_GLOBAL_MONTHLY_CHAR_QUOTA;
}

/** Refund reserved chars when the paid call ultimately spent nothing (Google
 *  returned null). Best-effort: a failed refund just leaves the reservation (the
 *  conservative direction — never under-counts spend). */
async function refundQuota(supabase: Supa, userId: string, chars: number): Promise<void> {
  const { error } = await supabase.rpc("refund_translation_quota", { p_user_id: userId, p_chars: chars });
  if (error) console.error("quota refund failed:", error.message);
}
async function refundGlobalQuota(supabase: Supa, chars: number): Promise<void> {
  const { error } = await supabase.rpc("refund_global_quota", { p_chars: chars });
  if (error) console.error("global quota refund failed:", error.message);
}

/** ATOMICALLY reserve `chars` against the GLOBAL monthly cap. Fails CLOSED on an RPC
 *  error: the global cap is the hard SPEND backstop, so if it can't be checked we
 *  must not spend (denies the paid call). Per-user quota stays fail-open for
 *  availability; this one protects the bill. Returns true when the call is allowed. */
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

/** All verified `words` rows for a lookup tuple (the multi-sense cache read). */
async function fetchVerified(
  supabase: Supa,
  input: string,
  sourceLang: string,
  targetLang: string,
): Promise<WordRow[]> {
  // Match the search term against EITHER the stored headword (`input`, e.g. 猫)
  // OR its reading (`input_reading`, e.g. ねこ), so a hiragana search resolves to
  // the kanji-headword rows the projection stores. QUOTE the interpolated value:
  // the PostgREST `or` grammar uses comma/parens/period as syntax, so a raw term
  // like "cat, dog" would corrupt the filter — double-quoting (with \ and " escaped)
  // makes it a literal value.
  const q = `"${input.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  const { data, error } = await supabase
    .from("words")
    .select("*")
    .eq("source_lang", sourceLang)
    .eq("target_lang", targetLang)
    .eq("is_verified", true)
    .or(`input.eq.${q},input_reading.eq.${q}`)
    // Order to MATCH jmdict_lookup's ranking (frequency DESC, then entry, then
    // sense), so the cached primary equals the lookup's primary even for a word
    // with several ENTRIES (顔 → かお-entry before かんばせ-entry). Ordering by
    // sense_pos ALONE scrambled entries that tie at sense 0 (the 顔/かんばせ bug).
    .order("frequency", { ascending: false, nullsFirst: false })
    .order("jmdict_entry_id", { ascending: true, nullsFirst: false })
    .order("jmdict_sense_pos", { ascending: true, nullsFirst: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as WordRow[];
}

/** Ranking order, mirroring fetchVerified's ORDER BY (frequency DESC NULLS LAST,
 *  then jmdict_entry_id ASC, then jmdict_sense_pos ASC NULLS LAST), for rows
 *  returned inline by upsert().select(). Keeps the primary consistent across
 *  multi-entry words (顔 → かお before かんばせ) instead of scrambling by sense alone. */
function sortBySensePos(rows: WordRow[]): WordRow[] {
  return [...rows].sort((a, b) => {
    // frequency DESC, NULLs last
    if (a.frequency == null !== (b.frequency == null)) return a.frequency == null ? 1 : -1;
    if (a.frequency != null && b.frequency != null && a.frequency !== b.frequency) {
      return b.frequency - a.frequency;
    }
    // jmdict_entry_id ASC (text; ent_seq are fixed-width numeric strings)
    const ea = a.jmdict_entry_id ?? "", eb = b.jmdict_entry_id ?? "";
    if (ea !== eb) return ea < eb ? -1 : 1;
    // jmdict_sense_pos ASC, NULLs (MT rows) last
    if (a.jmdict_sense_pos == null) return b.jmdict_sense_pos == null ? 0 : 1;
    if (b.jmdict_sense_pos == null) return -1;
    return a.jmdict_sense_pos - b.jmdict_sense_pos;
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
  // Quote each term: the PostgREST or()/in() grammar uses comma/parens/quote as
  // syntax, so a raw term would corrupt the filter (see fetchVerified).
  const quote = (v: string) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  const list = inputs.map(quote).join(",");
  const { data, error } = await supabase
    .from("words")
    .select("*")
    .eq("source_lang", sourceLang)
    .eq("target_lang", targetLang)
    .eq("is_verified", true)
    .or(`input.in.(${list}),input_reading.in.(${list})`)
    // Same ranking as fetchVerified (frequency DESC, entry, sense) so multi-entry
    // words keep the lookup's primary on the cache read.
    .order("frequency", { ascending: false, nullsFirst: false })
    .order("jmdict_entry_id", { ascending: true, nullsFirst: false })
    .order("jmdict_sense_pos", { ascending: true, nullsFirst: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as WordRow[];
}

// ── Idempotency (see migration 20260626) ───────────────────────────────────
// A retried request that already ran the PAID MT path must not re-call Google /
// re-reserve quota. We replay the stored response for the client's per-request key.
// Both helpers fail OPEN (a store blip just means the retry redoes the work — the
// same fail-open stance as the quota reserve).

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

/** Persist a paid response under the key so a retry replays it. Best-effort.
 *  INSERT-or-do-nothing: a key's response is immutable (first write wins), so this
 *  needs only INSERT — no UPDATE grant, and concurrent stores can't clobber. */
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

/** The success response for a set of verified rows (primary = first row). */
function respondWords(rows: WordRow[]) {
  return {
    translated: true,
    translation: rows[0].translation,
    word: toWord(rows[0]),
    words: rows.map(toWord),
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
 * BATCH resolve: many cacheable words (persist=true) in ONE request, so the
 * client's paragraph / add-many fan-out costs one round-trip instead of N. Same
 * per-word resolution as the single path (cache → JMdict → metered MT fallback),
 * just looped server-side with the cache read and the final upsert batched. The
 * whole-paragraph display gloss is NOT batched (it's a single persist=false call).
 */
async function resolveBatch(
  supabase: Supa,
  rawInputs: unknown[],
  sourceLang: string,
  targetLang: string,
  authHeader: string | null,
): Promise<BatchEntry[]> {
  // IDEMPOTENCY: unlike the single path, batch has no idempotency_keys entry — it
  // relies on the `words` cache instead. On success each MT word is upserted, so a
  // retry hits the cache (no re-spend). The only exposure is the narrow window where
  // MT ran but the upsert threw before caching: a retry re-calls MT + re-meters the
  // uncached subset. Accepted (rare; bounded by the per-word quota). Thread an
  // idempotency key here if exact batch metering ever matters.
  // NFC-normalize + dedupe, preserving first-seen order.
  const inputs: string[] = [];
  const seen = new Set<string>();
  for (const raw of rawInputs) {
    const v = String(raw ?? "").trim().normalize("NFC");
    // Same hard cap as the single path — skip pathological items before any lookup.
    if (v && v.length <= MAX_INPUT_CHARS && !seen.has(v)) { seen.add(v); inputs.push(v); }
  }
  if (inputs.length === 0) return [];

  // 1. One batched cache read; the still-uncached terms need resolving.
  const cachedRows = await fetchVerifiedMany(supabase, inputs, sourceLang, targetLang);
  const cachedByInput = groupByInput(cachedRows, inputs);
  const missing = inputs.filter((i) => (cachedByInput.get(i) ?? []).length === 0);

  // 2. Resolve all misses' DICTIONARY senses in ONE batched RPC (two for EN→JA:
  //    WordNet + gloss, merged per input) — the cold-paragraph N+1 fix. Was a
  //    per-word round-trip; now one (or two) calls regardless of miss count.
  const userId = userIdFromAuth(authHeader);
  const perInput: { input: string; results: ProviderResult[] }[] = [];
  const dictByInput = await resolveDictionaryMany(supabase, missing, sourceLang, targetLang);
  for (const input of missing) {
    const r = dictByInput.get(input);
    if (r && r.length > 0) perInput.push({ input, results: r });
  }

  // 3. MT fallback for the words the dictionary still missed — paid, so metered.
  //    Reserve the WHOLE batch's chars ONCE (per-user + global) rather than per
  //    word, so the app-wide global-quota lock + hot row is touched once per request
  //    instead of once per MT word (the global-quota serialization fix). Then call
  //    MT per word and refund the reserved-but-unspent remainder.
  const canMT = mtConfigured() && !!userId;
  const stillMissing = missing.filter((i) => !dictByInput.has(i));
  if (canMT && stillMissing.length > 0) {
    const limits = await resolveLimits(supabase, userId!);
    // (#2) over-cap entries are never sent to paid MT (the per-request paragraph cap
    // holds on the batch path too).
    const mtWords = stillMissing.filter((i) => i.length <= limits.paragraphCharLimit);
    const totalChars = mtWords.reduce((n, w) => n + w.length, 0);
    if (totalChars > 0) {
      const reserve = await reserveQuota(supabase, userId!, totalChars, limits.monthlyCharQuota);
      const globalOk = reserve.allowed && (await reserveGlobalQuota(supabase, totalChars, globalCharQuota()));
      if (reserve.committed && !globalOk) await refundQuota(supabase, userId!, totalChars); // global denied → undo per-user
      if (reserve.allowed && globalOk) {
        let spent = 0;
        for (const w of mtWords) {
          const mt = await callTranslationProvider(w, sourceLang, targetLang);
          if (mt) { perInput.push({ input: w, results: [mt] }); spent += w.length; }
        }
        // Refund what we reserved but didn't spend (words MT couldn't translate);
        // per-user only if the reserve committed.
        const unspent = totalChars - spent;
        if (unspent > 0) {
          if (reserve.committed) await refundQuota(supabase, userId!, unspent);
          await refundGlobalQuota(supabase, unspent);
        }
      }
    }
  }

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

  // 4. Map rows back to each SEARCH term.
  //    - Cache hits matched by headword/reading (groupByInput), same as the
  //      single-path cache read.
  //    - Freshly-resolved rows are mapped by dictionary_ref to the term that
  //      produced them. This is the fix for WRITING VARIANTS: 速い is a non-primary
  //      writing of はやい, stored under headword 早い, so neither its headword (早い)
  //      nor its reading (はやい) equals the search term 速い — groupByInput alone
  //      drops it (the single path doesn't, hence the single/batch discrepancy).
  const cachedByTerm = groupByInput(cachedRows, inputs);
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
    // An input is either a cache hit OR a miss (never both — see `missing`), so
    // these two sources don't overlap; combine + order primary-first.
    const ws = [...(cachedByTerm.get(input) ?? []), ...(savedByTerm.get(input) ?? [])].sort(bySensePos);
    return ws.length > 0
      ? { input, translated: true, translation: ws[0].translation, word: toWord(ws[0]), words: ws.map(toWord) }
      : { input, translated: false, translation: null, word: null, words: [] };
  });
}

// Best-effort append to the admin error_log (service role bypasses RLS — see
// migration 20260706). NEVER throws: a logging failure must not change the request
// outcome. The audit panel (admin_error_log RPC) reads these rows. Input is
// truncated so the log can't be bloated by a huge paragraph.
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

// HTTP handler — the request entry point.
// OUTPUT (JSON): { translated, translation, word, words } on success;
//   word = primary sense (back-compat), words = all senses. { error } + 4xx/5xx otherwise.
// CONSTRAINTS: POST only (+ OPTIONS/CORS); requires input/sourceLang/targetLang;
// rejects source == target; NFC-normalizes input; persist=false skips the cache
// (display-only); verified writes are system-owned (service role bypasses RLS).
async function handleRequest(req: Request): Promise<Response> {
  const cors = corsHeaders(
    req.headers.get("Origin"),
    parseAllowedOrigins(Deno.env.get("ALLOWED_ORIGINS")),
  );
  // All responses below carry the per-request CORS headers.
  const reply = (body: unknown, status = 200) => json(body, status, cors);

  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  // HEALTH CHECK (#8 observability): a GET is a cheap liveness probe for uptime
  // monitors / load balancers — no DB or provider call, never spends.
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

  // SINGLE mode: { input, persist?, idempotencyKey? }. NFC-normalize to match cache.
  // (EN inflection is lemmatized inside resolveDictionary, not here, so the cache key
  // stays the user's surface form.)
  const input = String(body.input ?? "").trim().normalize("NFC");
  // persist=false → translate for display only (a whole paragraph in context)
  // without reading/writing the cache; we don't store unique paragraphs.
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

  // 0. Idempotency replay: a retried PAID request already has its response stored
  //    (only the MT path stores — see usedMT below), so return it without re-spending.
  const prior = await lookupIdempotent(supabase, idempotencyKey);
  if (prior) return reply(prior.response, prior.status);

  // Did this request run the PAID MT path? Only then is the response stored, so a
  // retry replays it instead of re-calling Google / re-reserving quota.
  let usedMT = false;
  /** Reply, first storing the response under the idempotency key when MT was used. */
  const finish = async (resBody: unknown, status = 200) => {
    if (idempotencyKey && usedMT) await storeIdempotent(supabase, idempotencyKey, resBody, status);
    return reply(resBody, status);
  };

  // 1. Verified-cache check (all senses) -> no JMdict re-query. Words only;
  //    display-only paragraph translations skip the cache entirely.
  //    Only an EXACT-HEADWORD match is an authoritative, complete hit. A
  //    reading-only match (e.g. こと matching the cached 琴 via input_reading) may
  //    be PARTIAL — other homophones (事) might never have been cached — so fall
  //    through to the full lookup, which projects the complete set (after which the
  //    exact-headword row exists and future lookups hit the cache).
  if (persist) {
    const cached = await fetchVerified(supabase, input, sourceLang, targetLang);
    if (cached.some((r) => r.input === input)) return reply(respondWords(cached));
  }

  // 2. Resolve senses: JMdict first, then the Google MT fallback.
  //    The paid path runs ONLY when MT is configured (key + kill-switch off) AND the
  //    request is attributable to a user (a JWT `sub`). A call on the public anon key
  //    with no user session is NOT metered, so it must not spend → JMdict-only.
  //    (The app's guests are real anonymous-auth users, so they always have a sub.)
  const userId = userIdFromAuth(req.headers.get("Authorization"));
  let results = await resolveDictionary(supabase, input, sourceLang, targetLang);
  if (results.length === 0 && mtConfigured() && userId) {
    // MT is the only PAID path → enforce the caller's limits here, the hard
    // server-side gate (the client also pre-checks for UX). Both checks happen
    // BEFORE the provider call, so a rejected request costs nothing.
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
    // (b) cumulative MONTHLY quota → 429 (the hard free-tier ceiling). Reserve
    //     the chars ATOMICALLY before the paid call (no check-then-meter race);
    //     a denied reservation costs nothing.
    const { allowed, used, committed } = await reserveQuota(
      supabase, userId, input.length, monthlyCharQuota,
    );
    if (!allowed) {
      return reply(
        { error: "Monthly translation quota reached", used, quota: monthlyCharQuota },
        429,
      );
    }

    // (c) GLOBAL monthly cap across ALL users (the aggregate billing ceiling) → 429.
    //     Reserved atomically before the paid call, same as the per-user quota.
    const gQuota = globalCharQuota();
    const ok = await reserveGlobalQuota(supabase, input.length, gQuota);
    if (!ok) {
      // refund the per-user reservation — only if it actually committed (a fail-open
      // reserve added nothing, so refunding would erase legitimate prior usage).
      if (committed) await refundQuota(supabase, userId, input.length);
      console.error(JSON.stringify({ evt: "global_cap_reached", quota: gQuota }));
      return reply({ error: "Service translation quota reached, try again later", quota: gQuota }, 429);
    }

    // The paid path ran (quota reserved + Google attempted), so this response is
    // stored under the idempotency key — a retry replays it, no re-spend.
    usedMT = true;
    const mt = await callTranslationProvider(input, sourceLang, targetLang);
    if (mt) {
      results = [mt];
    } else {
      // Google spent nothing (non-2xx / network / empty) — refund both reservations
      // (per-user only if it committed).
      if (committed) await refundQuota(supabase, userId, input.length);
      await refundGlobalQuota(supabase, input.length);
    }
  }
  if (results.length === 0) {
    return finish({ translated: false, translation: null, word: null, words: [] });
  }

  // 3. Display-only (paragraph): return the primary text without caching.
  if (!persist) {
    return finish({
      translated: true,
      translation: results[0].translation,
      word: null,
      words: [],
    });
  }

  // 4. Persist every sense as a verified global word (service role bypasses RLS).
  //    projectRows (in _lib.ts) stores the canonical headword as `input`, DEDUPEs
  //    by (headword, translation) — JMdict can yield the SAME string twice (私 →
  //    "I; me"), and distinct translations carry distinct refs, so the dedupe also
  //    prevents a duplicate onConflict key (Postgres 21000) — and computes the
  //    STABLE dictionary_ref (the onConflict target) so a re-projection UPDATEs in
  //    place (word_id, hence user_words refs, survive) instead of forking.
  const rows = projectRows(results, input, sourceLang, targetLang, CURRENT_PROJECTION_VERSION);
  // upsert().select() returns the written rows inline — no second read round-trip.
  // On a miss the cache was empty, so these ARE the full verified set for `input`
  // (sort to primary-first; the kana-search headword swap is already in the rows).
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
    // finish() (not reply): if MT already spent on this request, STORE the response
    // under the idempotency key so a client retry replays this 500 instead of
    // re-reserving quota + re-calling Google (#4 — double-spend on upsert failure).
    return finish({ error: "Translation failed" }, 500); // generic — no schema/SQL leak
  }

  const ordered = sortBySensePos((saved ?? []) as WordRow[]);
  return reply(ordered.length > 0 ? respondWords(ordered) : {
    translated: true,
    translation: results[0].translation,
    word: null,
    words: [],
  });
}

// Entry point: time every request and emit ONE structured access-log line (#8
// observability) — method, status, duration. A 5xx also logs as an error so it
// surfaces in alerting. Errors never escape (a thrown handler → logged 500), so a
// bug can't take the function down silently.
Deno.serve(async (req) => {
  const start = Date.now();
  let res: Response;
  try {
    res = await handleRequest(req);
  } catch (e) {
    console.error("translate handler crashed:", e);
    // Best-effort audit on an unhandled crash. Never rethrows.
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
