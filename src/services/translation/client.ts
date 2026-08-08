// Frontend translation client — a typed RPC wrapper, nothing more.
//
// The browser cannot translate, only ASK the server to: the API key and the provider
// call live in the `translate` edge function, so there is no provider here to swap,
// mock, or extract from the bundle. Swapping the provider never touches this file.

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
  /** The primary verified word (first of `words`); null for display-only calls. */
  word: Word | null;
  /** ALL verified senses persisted for this lookup, primary first. JMdict is
   *  multi-sense, so this can hold several; the MT fallback yields at most one. */
  words?: Word[];
}

const MAX_ATTEMPTS = 3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * True for a TRANSIENT edge failure worth retrying: a fetch failure (a dropped
 * connection, or an edge isolate killed by its wall-clock limit) or a gateway 5xx.
 * A 4xx (413/429 limits) is deliberate and is NOT retried.
 */
function isTransient(error: { name?: string; context?: unknown }): boolean {
  if (error?.name === "FunctionsFetchError" || error?.name === "FunctionsRelayError") {
    return true;
  }
  const status = (error?.context as { status?: number } | undefined)?.status;
  return typeof status === "number" && status >= 500;
}

/** Invoke the edge function with the transient-failure retry/backoff, shared by the
 *  single and batch entry points. Throws on a deliberate (4xx) or exhausted failure.
 *
 *  The idempotency key is generated ONCE per logical call, not per attempt, so all
 *  retries carry the SAME key and the edge replays a stored PAID response instead of
 *  re-calling Google. The batch path ignores it (already cache-idempotent). */
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
    if (attempt < MAX_ATTEMPTS && isTransient(error)) {
      await sleep(150 * attempt);
      continue;
    }
    throw toServiceError(error);
  }
  throw toServiceError(lastError);
}

/**
 * Ask the server to translate `input`. The result is cached as a verified word by
 * default; pass `persist: false` for display-only text (a whole paragraph), which must
 * not be stored and comes back with `word` null. `sourceLang` must already be concrete.
 */
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
 * BATCH translate: many cacheable words in ONE round-trip, collapsing the paragraph /
 * add-many fan-out from N edge calls to one. Keyed by the term SENT, so a kana search
 * resolves under that kana even though the stored headword is the kanji; a term with no
 * result maps to []. persist is implied true — the paragraph gloss stays a separate
 * persist:false `translate` call.
 *
 * `dictionaryOnly` restricts resolution to the cache + dictionary, never paid MT. Use
 * it when PROBING whether a string is a real word rather than translating something the
 * user asked for: probes are expected to miss, and billing for each wrong guess — then
 * caching its output as verified — is exactly the wrong answer.
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

/**
 * SEGMENTS translate: one display gloss PER SEGMENT, index-aligned, in ONE round-trip —
 * which is what lets the reader print the English under the sentence it belongs to.
 * Splitting one blob of translated text back apart can't promise that, since MT merges
 * and splits sentences freely.
 *
 * Display-only like the paragraph gloss: nothing is cached, the dictionary path is
 * skipped, and it meters as ONE paid request (the edge dedupes repeats before billing).
 * A `null` entry means that segment came back empty — render its source instead.
 */
export async function translateSegments(params: {
  segments: string[];
  sourceLang: LangCode;
  targetLang: LangCode;
}): Promise<(string | null)[]> {
  if (params.segments.length === 0) return [];
  const data = await invokeTranslate<{ glosses?: (string | null)[] }>(params);
  const glosses = data.glosses ?? [];
  // Never let a short/garbled response shift the alignment — pad to the request.
  return params.segments.map((_, i) => glosses[i] ?? null);
}
