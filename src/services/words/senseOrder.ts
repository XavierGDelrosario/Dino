// How a word's cached senses are ORDERED on the client — the twin of the edge's
// fetchVerified + preferWrittenForm (supabase/functions/translate/index.ts, _lib.ts).
//
// The client reads `words` directly and serves a hit without asking the edge, so if it
// ordered senses its own way, the same word would show one primary when cached and
// another when fresh. Pure; the repository fetches, this ranks.

import type { Word } from "./repository";

/** Han range — "did the user type kanji". Same range as the edge. */
const HAS_KANJI = /[一-鿿]/u;

/** Does the cache read for `term` also match `input_reading`? (Kanji terms, see repository.ts.) */
export function matchesReadingSide(term: string): boolean {
  return HAS_KANJI.test(term);
}

/** Into-Japanese from another language: the projected sense rank orders, not frequency. */
function isReverseIntoJa(sourceLang: string, targetLang: string): boolean {
  return sourceLang.toUpperCase() !== "JA" && targetLang.toUpperCase() === "JA";
}

/**
 * Order one term's senses. `senses` must arrive in the database's sense order (sense_rank)
 * — every step here is a STABLE sort, so that order survives inside each entry.
 *
 *   1. JA→EN: frequency DESC (nulls last), then common, then entry — so a multi-entry word's primary
 *      is its most common entry, as jmdict_lookup ranks it. EN→JA keeps the rank order.
 *   2. A kanji term ranks in four tiers: written this way AND common, common, written
 *      this way, the rest (migration 20260769). 為 → ため, not 為 read い (a koto string).
 */
export function orderSenses(senses: Word[], term: string, sourceLang: string, targetLang: string): Word[] {
  if (senses.length < 2) return senses;
  let out = senses;
  if (!isReverseIntoJa(sourceLang, targetLang)) {
    out = [...senses].sort((a, b) => {
      if ((a.frequency == null) !== (b.frequency == null)) return a.frequency == null ? 1 : -1;
      if (a.frequency != null && b.frequency != null && a.frequency !== b.frequency) {
        return b.frequency - a.frequency;
      }
      // A frequency TIE goes to the common entry, as jmdict_lookup breaks it: いい and
      // 謂 (a rare uk noun) share the kana's frequency, and 謂 has the lower entry id.
      if ((a.isCommon === true) !== (b.isCommon === true)) return a.isCommon === true ? -1 : 1;
      const ea = a.jmdictEntryId ?? "", eb = b.jmdictEntryId ?? "";
      return ea === eb ? 0 : ea < eb ? -1 : 1;
    });
  }
  return preferWrittenForm(out, term);
}

/** Client twin of the edge's preferWrittenForm (_lib.ts). */
export function preferWrittenForm<T extends Pick<Word, "input" | "isCommon">>(rows: T[], term: string): T[] {
  if (rows.length < 2 || !HAS_KANJI.test(term)) return rows;
  const tiers: T[][] = [[], [], [], []];
  for (const r of rows) tiers[3 - ((r.isCommon === true ? 2 : 0) + (r.input === term ? 1 : 0))].push(r);
  return tiers.flat();
}
