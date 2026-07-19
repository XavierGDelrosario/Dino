// =========================================================
// Frontend translation client.
//
// The browser cannot translate — it can only ASK the server to. The API key
// and the actual provider call live in the `translate` Supabase Edge Function
// (supabase/functions/translate). This module is just the typed RPC wrapper,
// so there is no provider to swap, mock, or extract from the bundle.
//
// The provider behind the edge function is JMdict (primary) + Google Cloud
// Translation v2 (MT fallback); swapping it never touches this client.
// =========================================================

import { supabase } from "../../config/supabaseClient";
import { ServiceError, toServiceError } from "../errors";
import type { LangCode } from "../language";
import type { Word } from "../words/repository";

/** Max concurrent translate() calls when translating many words at once. */
export const MAX_TRANSLATION_CONCURRENCY = 6;

export interface TranslationResult {
  /** false when the provider returned no result (caller shows the input). */
  translated: boolean;
  /** The translated text (primary sense), or null when nothing was translated. */
  translation: string | null;
  /**
   * The primary cached verified word, when persisted (first of `words`). Null
   * for display-only calls (persist=false) and when translation failed.
   */
  word: Word | null;
  /**
   * ALL verified senses persisted for this lookup (primary first). A real
   * dictionary (JMdict) is multi-sense, so this can hold several; the MT
   * fallback yields at most one. Empty for display-only / failed calls.
   */
  words?: Word[];
}

/**
 * Asks the server to translate `input`. By default the result is cached as a
 * verified word (`persist`); pass `persist: false` for display-only text such
 * as a whole paragraph, which must not be stored.
 *
 * OUTPUT: TranslationResult { translated, translation: string|null, word: Word|null }.
 * CONSTRAINTS: `sourceLang` must already be concrete (resolve "Detect language"
 * first); persist defaults true (caches a verified word); persist:false →
 * display-only, word is null.
 */
const MAX_ATTEMPTS = 3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * True for a TRANSIENT edge failure worth retrying: a network/fetch failure
 * (supabase-js `FunctionsFetchError` — e.g. a dropped connection or a local
 * edge isolate killed by its wall-clock limit, which the browser surfaces as
 * "NetworkError when attempting to fetch resource") or a 5xx from the gateway.
 * A 4xx (e.g. 413/429 limits) is deliberate and is NOT retried.
 */
function isTransient(error: { name?: string; context?: unknown }): boolean {
  if (error?.name === "FunctionsFetchError" || error?.name === "FunctionsRelayError") {
    return true;
  }
  const status = (error?.context as { status?: number } | undefined)?.status;
  return typeof status === "number" && status >= 500;
}

/** Invoke the edge function with the transient-failure retry/backoff, shared by
 *  the single and batch entry points. Throws on a deliberate (4xx) or exhausted
 *  failure; returns the function's data otherwise.
 *
 *  Idempotency: a key is generated ONCE per logical call (not per attempt), so all
 *  retries carry the SAME key. The edge replays the stored response for a retried
 *  PAID request (the persist=false paragraph gloss) instead of re-calling Google /
 *  re-reserving quota. The batch path ignores it (already cache-idempotent). */
async function invokeTranslate<T>(body: Record<string, unknown>): Promise<T> {
  const idempotencyKey =
    globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const keyedBody = { ...body, idempotencyKey };
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const { data, error } = await supabase.functions.invoke<T>("translate", { body: keyedBody });

    if (!error) {
      if (!data) throw new ServiceError("Empty response from translate function");
      return data;
    }

    lastError = error;
    // Retry transient failures with a short backoff; surface deliberate ones now.
    if (attempt < MAX_ATTEMPTS && isTransient(error)) {
      await sleep(150 * attempt);
      continue;
    }
    throw toServiceError(error);
  }
  throw toServiceError(lastError);
}

export async function translate(params: {
  input: string;
  sourceLang: LangCode;
  targetLang: LangCode;
  persist?: boolean;
}): Promise<TranslationResult> {
  return invokeTranslate<TranslationResult>(params);
}

/** One batch entry: a search term plus the verified senses resolved for it. */
interface BatchEntry {
  input: string;
  words?: Word[];
}

/**
 * BATCH translate: resolve many cacheable words in ONE round-trip (the edge
 * function loops cache → JMdict → MT per word and persists them all). Collapses
 * the paragraph / add-many per-word fan-out from N edge calls to one.
 *
 * OUTPUT: Map<searchTerm, Word[]> — every requested term is a key; terms with no
 * result map to an empty array. Keyed by the term SENT (so a kana search resolves
 * under that kana even though the stored headword is the kanji).
 * CONSTRAINTS: persist is implied true (batch is for cacheable words); the
 * whole-paragraph display gloss stays a separate persist:false `translate` call.
 *
 * `dictionaryOnly` restricts resolution to the cache + dictionary, never the paid
 * MT fallback. Use it when PROBING whether a string is a real word (the reader's
 * compound merge) rather than translating something the user asked for: probes are
 * expected to miss, and billing MT for each wrong guess — then caching its output
 * as a verified word — is exactly the wrong answer. See the edge-side note.
 */
export async function translateBatch(params: {
  inputs: string[];
  sourceLang: LangCode;
  targetLang: LangCode;
  dictionaryOnly?: boolean;
}): Promise<Map<string, Word[]>> {
  const map = new Map<string, Word[]>();
  if (params.inputs.length === 0) return map;
  const data = await invokeTranslate<{ results?: BatchEntry[] }>(params);
  for (const r of data.results ?? []) map.set(r.input, r.words ?? []);
  return map;
}
