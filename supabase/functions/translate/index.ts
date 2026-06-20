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
  parseAllowedOrigins,
  projectRows,
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
const CURRENT_PROJECTION_VERSION = 2;

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
  }) => ({
    translation: row.translation,
    inputReading: row.input_reading ?? null,
    translationReading: row.translation_reading ?? null,
    headword: row.writing ?? null,
    entryId: row.jmdict_entry_id ?? null,
    sensePos: row.sense_position ?? null,
  }));
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
): Promise<{ allowed: boolean; used: number }> {
  const { data, error } = await supabase.rpc("consume_translation_quota", {
    p_user_id: userId,
    p_chars: chars,
    p_quota: quota,
  });
  if (error) {
    console.error("quota reservation failed:", error.message);
    return { allowed: true, used: 0 }; // fail open
  }
  const row = Array.isArray(data) ? data[0] : data;
  return { allowed: row?.allowed !== false, used: row?.used ?? 0 };
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
  const cors = corsHeaders(
    req.headers.get("Origin"),
    parseAllowedOrigins(Deno.env.get("ALLOWED_ORIGINS")),
  );
  // All responses below carry the per-request CORS headers.
  const reply = (body: unknown, status = 200) => json(body, status, cors);

  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply({ error: "Method not allowed" }, 405);

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
    return reply({ error: "Invalid JSON body" }, 400);
  }

  if (!input || !sourceLang || !targetLang) {
    return reply({ error: "input, sourceLang and targetLang are required" }, 400);
  }
  if (sourceLang === targetLang) {
    return reply({ error: "Source and target language are the same" }, 400);
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // 1. Verified-cache check (all senses) -> no JMdict re-query. Words only;
  //    display-only paragraph translations skip the cache entirely.
  if (persist) {
    const cached = await fetchVerified(supabase, input, sourceLang, targetLang);
    if (cached.length > 0) return reply(respondWords(cached));
  }

  // 2. Resolve senses: JMdict first, then the Google MT fallback.
  let results = await lookupJMdict(supabase, input, sourceLang, targetLang);
  if (results.length === 0) {
    // MT is the only PAID path → enforce the caller's limits here, the hard
    // server-side gate (the client also pre-checks for UX). Both checks happen
    // BEFORE the provider call, so a rejected request costs nothing.
    const userId = userIdFromAuth(req.headers.get("Authorization"));
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
    //     a denied reservation costs nothing. Only when usage is attributable to a
    //     user (a JWT sub); anon-keyed calls skip metering.
    if (userId) {
      const { allowed, used } = await reserveQuota(
        supabase, userId, input.length, monthlyCharQuota,
      );
      if (!allowed) {
        return reply(
          { error: "Monthly translation quota reached", used, quota: monthlyCharQuota },
          429,
        );
      }
    }

    const mt = await callTranslationProvider(input, sourceLang, targetLang);
    if (mt) results = [mt];
  }
  if (results.length === 0) {
    return reply({ translated: false, translation: null, word: null, words: [] });
  }

  // 3. Display-only (paragraph): return the primary text without caching.
  if (!persist) {
    return reply({
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
  const { error: insertError } = await supabase
    .from("words")
    .upsert(rows, {
      onConflict: "dictionary_ref,source_lang,target_lang",
    });
  if (insertError) return reply({ error: insertError.message }, 500);

  // 5. Return the full verified set (re-read for a consistent shape with the
  //    cache-hit path), primary sense first.
  const saved = await fetchVerified(supabase, input, sourceLang, targetLang);
  return reply(saved.length > 0 ? respondWords(saved) : {
    translated: true,
    translation: results[0].translation,
    word: null,
    words: [],
  });
});
