// =========================================================
// Level-based new-words quiz — the client seam (Proficiency.md feature 2).
//
// Asks the edge function for N UNSEEN words at a proficiency band (JLPT N5..N1 for
// Japanese), which it sources from JMdict (the lazy `words` cache is incomplete)
// and projects into verified `words` rows. Returns them as QUIZ CARDS — one entry
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
 * services/proficiency); only JA→EN (JLPT) is populated today.
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
