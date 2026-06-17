// =========================================================
// `translate` Edge Function — the ONLY place translation happens.
//
// Holds the provider API key (server-side env) and a service-role Supabase
// client so it can write VERIFIED words to the global cache — something
// browser clients can never do (RLS forbids is_verified = true from clients).
//
// Find-or-Create (server side, race-safe against duplicate API bills):
//   1. Look for an existing verified translation -> return it, no API call.
//   2. Miss -> call the translation provider.
//   3. No result -> { translated: false, word: null }.
//   4. Success -> upsert a verified word and return it.
//
// PROVIDER NOT FINALIZED: callTranslationProvider() below is an UNIMPLEMENTED
// stub that throws until a real provider (DeepL/Google/other) is wired in. It
// is the only place a provider is called; nothing else changes when one is added.
//
// Required env: the auto-provided SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.
// A provider adds its own env (e.g. an API key/URL) when implemented. Global
// `words` rows are system-owned by construction (only this function writes), so
// they carry no per-creator column.
// =========================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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
  is_verified: boolean;
}

// snake_case DB row -> camelCase Word (matches src/services/words/repository.ts)
// readings are NULL until the dictionary source (JMdict) is wired into
// callTranslationProvider; they flow through here so cache reads carry them.
function toWord(r: WordRow) {
  return {
    wordId: r.word_id,
    input: r.input,
    translation: r.translation,
    sourceLang: r.source_lang,
    targetLang: r.target_lang,
    inputReading: r.input_reading ?? null,
    translationReading: r.translation_reading ?? null,
    isVerified: r.is_verified,
  };
}

// The single seam for the translation provider — the ONLY place an MT provider
// is called. UNIMPLEMENTED for the POC (no provider finalized): it throws until
// a real one is wired in, so it is never silently a specific provider.
//
// OUTPUT (once implemented): translated string, or null on no-result / failure.
// CONSTRAINTS: wiring a provider means replacing this body WHOLESALE — auth
// header, request shape, AND response parsing are all provider-specific, so a
// generic URL/key alone is not enough.
//
// Reference (DeepL, api-free.deepl.com/v2/translate) — if chosen, replace the
// throw below with:
//   const key = Deno.env.get("DEEPL_API_KEY");
//   if (!key) throw new Error("DEEPL_API_KEY is not set");
//   const url = Deno.env.get("DEEPL_API_URL")
//     ?? "https://api-free.deepl.com/v2/translate";
//   const body = new URLSearchParams({ text, target_lang: targetLang });
//   if (sourceLang) body.set("source_lang", sourceLang);
//   const res = await fetch(url, { method: "POST", headers: {
//     Authorization: `DeepL-Auth-Key ${key}`,
//     "Content-Type": "application/x-www-form-urlencoded" }, body });
//   if (!res.ok) return null;
//   return (await res.json())?.translations?.[0]?.text ?? null;
async function callTranslationProvider(
  _text: string,
  _sourceLang: string,
  _targetLang: string,
): Promise<string | null> {
  throw new Error(
    "No translation provider configured — implement callTranslationProvider " +
      "(see the DeepL reference above)."
  );
}

// HTTP handler — the request entry point.
// OUTPUT (JSON): { translated, translation, word } on success; { error } + 4xx/5xx otherwise.
// CONSTRAINTS: POST only (+ OPTIONS/CORS); requires input/sourceLang/targetLang;
// rejects source == target; NFC-normalizes input; persist=false skips the cache;
// verified writes are system-owned (service role bypasses RLS).
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let input = "";
  let sourceLang = "";
  let targetLang = "";
  let persist = true;
  try {
    const body = await req.json();
    // NFC-normalize to match the client's cache keys (composed/decomposed,
    // full/half-width collapse to one form).
    input = String(body.input ?? "").trim().normalize("NFC");
    sourceLang = String(body.sourceLang ?? "");
    targetLang = String(body.targetLang ?? "");
    // persist=false → translate for display only (a whole paragraph in context)
    // without reading/writing the cache; we don't store unique paragraphs.
    // Individual WORDS use the default (true) so every word stays cached.
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

  // 1. Verified-cache check (any creator) -> no provider bill. Words only;
  //    display-only paragraph translations skip the cache entirely.
  if (persist) {
    const { data: cached, error: cacheError } = await supabase
      .from("words")
      .select("*")
      .eq("input", input)
      .eq("source_lang", sourceLang)
      .eq("target_lang", targetLang)
      .eq("is_verified", true)
      .limit(1)
      .maybeSingle();

    if (cacheError) return json({ error: cacheError.message }, 500);
    if (cached) {
      return json({
        translated: true,
        translation: cached.translation,
        word: toWord(cached),
      });
    }
  }

  // 2. Translate.
  const translation = await callTranslationProvider(input, sourceLang, targetLang);
  if (!translation) {
    return json({ translated: false, translation: null, word: null });
  }

  // 3. Display-only (paragraph): return the text without caching it.
  if (!persist) {
    return json({ translated: true, translation, word: null });
  }

  // 4. Persist as a verified global word (service role bypasses RLS).
  const { data: inserted, error: insertError } = await supabase
    .from("words")
    .upsert(
      {
        input,
        translation,
        source_lang: sourceLang,
        target_lang: targetLang,
        is_verified: true,
      },
      {
        onConflict:
          "input,translation,source_lang,target_lang,is_verified",
      },
    )
    .select("*")
    .single();

  if (insertError) return json({ error: insertError.message }, 500);
  return json({ translated: true, translation, word: toWord(inserted) });
});
