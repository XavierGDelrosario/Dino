// =========================================================
// Level-based new-words quiz — the client seam (Proficiency.md feature 2).
//
// Asks the edge function for N UNSEEN words at a proficiency band (JLPT N5..N1 for
// Japanese, CEFR A1..C2 for English), which it sources from the server-only
// wordlists — JMdict for JA, english_proficiency + WordNet for EN, since the lazy
// `words` cache is incomplete — and projects into verified `words` rows. Returns them as QUIZ CARDS — one entry
// per word, its full sense list primary-first — the exact shape useTextQuiz
// consumes (same as the reader's addableCards), so the learn session reuses the
// existing save-then-review flashcard loop.
//
// Like translation, the browser can't do this itself: only the edge function
// (service role) can read the server-only JMdict tables and write the cache.
// =========================================================

import { supabase } from "../config/supabaseClient";
import { ServiceError, toServiceError } from "./errors";
import type { LangCode } from "./language";
import type { Word } from "./words/repository";

/**
 * Fetch up to `limit` unseen words at proficiency `band`, as quiz cards.
 *
 * OUTPUT: Word[][] — one card per word (its senses, primary first); empty when
 * the level has no new words left (or the language has no curated framework).
 * CONSTRAINTS: `band` is the raw ordinal (1 = easiest … ascending = harder — see
 * services/proficiency), so it means N5..N1 for JA→EN (JLPT, 5 bands) and A1..C2
 * for EN→JA (CEFR, 6 bands). Those two pairs are the populated ones; any other
 * pair returns empty (migration 20260745).
 *
 * `excludeSeen` (default true) omits words already in the user's vocabulary — the
 * LEARN quiz wants only new words. The CALIBRATION quiz passes false to sample the
 * whole band (it estimates how much of the band the user knows, saved or not).
 */
export async function fetchLearnWords(params: {
  band: number;
  source: LangCode;
  target: LangCode;
  limit?: number;
  excludeSeen?: boolean;
}): Promise<Word[][]> {
  // A pair needs two different languages, and the edge enforces it with a 400 raised
  // BEFORE the learn branch — which supabase-js reports only as "Edge Function returned
  // a non-2xx status code", with nothing in error_log because the request never reached
  // the part that logs. Fail here instead, where the message can name the cause. Callers
  // should not be able to construct this (see LearnView's picker, which swaps), so this
  // is a backstop for the next surface that grows a language selector.
  if (params.source === params.target) {
    throw new ServiceError(
      `Cannot draw words for ${params.source}→${params.target}: the language you're studying and the one it's explained in must differ.`,
      "validation",
    );
  }
  const { data, error } = await supabase.functions.invoke<{ cards?: Word[][] }>("translate", {
    body: {
      learn: { band: params.band, limit: params.limit, excludeSeen: params.excludeSeen },
      sourceLang: params.source,
      targetLang: params.target,
    },
  });
  if (error) throw toServiceError(error);
  if (!data) throw new ServiceError("Empty response from translate function");
  return data.cards ?? [];
}
