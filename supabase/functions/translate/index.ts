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
// PROVIDER NOT FINALIZED: DeepL vs Google vs other is undecided for the POC.
// The provider is isolated to callTranslationProvider() below — swap that one
// function (and its env vars) to change providers; nothing else is affected.
//
// Required env: TRANSLATION_API_KEY, SYSTEM_USER_ID (a users row that owns
// global entries), plus auto-provided SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.
// Optional: TRANSLATION_API_URL.
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
  is_verified: boolean;
  created_by: string | null;
}

// snake_case DB row -> camelCase Word (matches src/services/words/repository.ts)
function toWord(r: WordRow) {
  return {
    wordId: r.word_id,
    input: r.input,
    translation: r.translation,
    sourceLang: r.source_lang,
    targetLang: r.target_lang,
    isVerified: r.is_verified,
    createdBy: r.created_by,
  };
}

// The single swappable seam for the translation provider.
// OUTPUT: translated string, or null on no-result / failure.
// CONSTRAINTS: needs TRANSLATION_API_KEY; provider call lives only here.
//
// PLACEHOLDER IMPLEMENTATION: currently shaped for DeepL, but the provider is
// not confirmed for the POC. To switch (e.g. Google Translate), rewrite only
// this function's body and its env vars — the contract stays the same.
async function callTranslationProvider(
  text: string,
  sourceLang: string,
  targetLang: string,
): Promise<string | null> {
  const key = Deno.env.get("TRANSLATION_API_KEY");
  if (!key) throw new Error("TRANSLATION_API_KEY is not set");
  const url =
    Deno.env.get("TRANSLATION_API_URL") ??
    "https://api-free.deepl.com/v2/translate";

  const body = new URLSearchParams({ text, target_lang: targetLang });
  if (sourceLang) body.set("source_lang", sourceLang);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `DeepL-Auth-Key ${key}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!res.ok) return null;
  const data = await res.json();
  return data?.translations?.[0]?.text ?? null;
}

// HTTP handler — the request entry point.
// OUTPUT (JSON): { translated, translation, word } on success; { error } + 4xx/5xx otherwise.
// CONSTRAINTS: POST only (+ OPTIONS/CORS); requires input/sourceLang/targetLang;
// rejects source == target; NFC-normalizes input; persist=false skips the cache;
// verified writes use created_by = SYSTEM_USER_ID (that users row must exist).
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
        created_by: Deno.env.get("SYSTEM_USER_ID") ?? "system",
      },
      {
        onConflict:
          "input,translation,source_lang,target_lang,created_by,is_verified",
      },
    )
    .select("*")
    .single();

  if (insertError) return json({ error: insertError.message }, 500);
  return json({ translated: true, translation, word: toWord(inserted) });
});
