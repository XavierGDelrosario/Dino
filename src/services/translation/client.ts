// =========================================================
// Frontend translation client.
//
// The browser cannot translate — it can only ASK the server to. The API key
// and the actual provider call live in the `translate` Supabase Edge Function
// (supabase/functions/translate). This module is just the typed RPC wrapper,
// so there is no provider to swap, mock, or extract from the bundle.
//
// NOTE: the translation provider is NOT finalized
// =========================================================

import { supabase } from "../../config/supabaseClient";
import type { LangCode } from "../language";
import type { Word } from "../words/repository";

/** Max concurrent translate() calls when translating many words at once. */
export const MAX_TRANSLATION_CONCURRENCY = 6;

export interface TranslationResult {
  /** false when the provider returned no result (caller shows the input). */
  translated: boolean;
  /** The translated text, or null when nothing was translated. */
  translation: string | null;
  /**
   * The cached verified word, when persisted. Null for display-only calls
   * (persist=false) and when translation failed.
   */
  word: Word | null;
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
export async function translate(params: {
  input: string;
  sourceLang: LangCode;
  targetLang: LangCode;
  persist?: boolean;
}): Promise<TranslationResult> {
  const { data, error } = await supabase.functions.invoke<TranslationResult>(
    "translate",
    { body: params }
  );

  if (error) throw error;
  if (!data) throw new Error("Empty response from translate function");

  return data;
}
