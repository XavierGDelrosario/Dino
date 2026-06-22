// =========================================================
// Pure, runtime-agnostic helpers for the `translate` edge function.
//
// Extracted so they can be UNIT-TESTED from the Node/Vitest suite — the edge
// function itself runs in Deno and imports supabase-js by URL, so it can't be
// imported into Vitest, and its top-level Deno.serve() would start a server on
// import. Nothing here touches Deno, Request, env, or the network; index.ts does
// all the I/O and calls these. Deno imports this as "./_lib.ts"; the Vitest spec
// imports it as "../../supabase/functions/translate/_lib".
// =========================================================

/** One projected sense: translation + optional per-side readings + JMdict identity. */
export interface ProviderResult {
  translation: string;
  inputReading?: string | null;
  translationReading?: string | null;
  // JA->EN: the canonical JA headword (kanji if the entry has one, else kana) to
  // store as `input`. null/undefined → use the search term as-is (EN->JA, MT).
  headword?: string | null;
  // STABLE JMdict source identity (null for MT). JA->EN: sensePos = sense index;
  // EN->JA: the match rank (informational).
  entryId?: string | null;
  sensePos?: number | null;
  // Difficulty axis: corpus-frequency rank (lower = more common; null for MT).
  frequency?: number | null;
  // POS tags of the sense (null for MT).
  partOfSpeech?: string[] | null;
}

/** A `words` row ready for upsert (snake_case, matches the table). */
export interface WordRowInsert {
  input: string;
  translation: string;
  source_lang: string;
  target_lang: string;
  input_reading: string | null;
  translation_reading: string | null;
  part_of_speech: string[] | null;
  frequency: number | null;
  // Always null from projection — JMdict carries no JLPT; a later curated ingest
  // populates it. Listed so the upsert row shape matches the table.
  difficulty_override: number | null;
  jmdict_entry_id: string | null;
  jmdict_sense_pos: number | null;
  dictionary_ref: string;
  projection_version: number;
  is_verified: boolean;
}

// App language codes are uppercase short codes (JA/EN/KO/ZH); Google v2 wants
// ISO-639-1 lowercase. Split-script Chinese maps to its regional code.
export function toGoogleLang(lang: string): string {
  const code = lang.trim().toLowerCase();
  switch (code) {
    case "zh-hans":
      return "zh-CN";
    case "zh-hant":
      return "zh-TW";
    default:
      return code; // ja, en, ko, zh, …
  }
}

/**
 * The caller's user id from the request JWT's `sub` (signature verified upstream
 * by the gateway). null for the bare anon key / unauthenticated / malformed token
 * → callers fall back to default limits. Handles base64url (no-padding) payloads.
 */
export function userIdFromAuth(authHeader: string | null): string | null {
  const token = (authHeader ?? "").replace(/^Bearer\s+/i, "");
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const claims = JSON.parse(atob(padded));
    return typeof claims.sub === "string" ? claims.sub : null;
  } catch {
    return null;
  }
}

/**
 * CORS headers for a request Origin against an allow-list. Empty list → "*"
 * (dev convenience). Non-empty → echo the Origin if it's listed, else grant none
 * ("null", a non-usable value). NOTE: the local `supabase start` Kong gateway
 * rewrites this to "*"; the function's value is authoritative only in production.
 */
export function corsHeaders(
  origin: string | null,
  allowedOrigins: string[],
): Record<string, string> {
  const allowOrigin = allowedOrigins.length === 0
    ? "*"
    : allowedOrigins.includes(origin ?? "")
      ? (origin as string)
      : "null";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

/** Parse a comma-separated ALLOWED_ORIGINS env value into a trimmed list. */
export function parseAllowedOrigins(raw: string | undefined | null): string[] {
  return (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Project provider results into verified `words` rows. Stores the canonical
 * headword (kanji writing for JA->EN) as `input` so a kana search keeps the kanji.
 * DEDUPEs by (headword, translation): JMdict can yield several senses aggregating
 * to the SAME string (私 → "I; me" twice) — keep the first. Distinct translations
 * carry distinct dictionary_refs, so the dedupe also prevents a duplicate
 * onConflict key (a single ON CONFLICT can't update one row twice — Postgres
 * 21000). The STABLE dictionary_ref pins a row to its SOURCE sense, not the
 * mutable headword, so a re-projection UPDATEs in place instead of forking:
 *   MT (no entry):       'mt:<input>'
 *   JA-source (headword): '<entry>:<pos>'   (headword is a projection output)
 *   EN-source (no head):  '<input>:<entry>' (input is the stable search term)
 */
export function projectRows(
  results: ProviderResult[],
  input: string,
  sourceLang: string,
  targetLang: string,
  projectionVersion: number,
): WordRowInsert[] {
  const seen = new Set<string>();
  const rows: WordRowInsert[] = [];
  for (const r of results) {
    const head = r.headword ?? input;
    const key = `${head} ${r.translation}`;
    if (seen.has(key)) continue;
    seen.add(key);
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
      part_of_speech: r.partOfSpeech ?? null,
      frequency: r.frequency ?? null,
      difficulty_override: null,
      jmdict_entry_id: r.entryId ?? null,
      jmdict_sense_pos: r.sensePos ?? null,
      dictionary_ref: ref,
      projection_version: projectionVersion,
      is_verified: true,
    });
  }
  return rows;
}
