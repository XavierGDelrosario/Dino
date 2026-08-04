// =========================================================
// Put the sense the CONTEXT actually used first (PURE, tested).
//
// A homograph carries several senses under one surface, and the dictionary hands
// them back in its own order — frequency, then entry id. In free text that order is
// often wrong for the sentence in front of you: 辛い is からい ("spicy") in
// 「このカレーは辛い」 and つらい ("painful") in 「練習が辛い」, but the card showed
// whichever the dictionary ranked first either way. The learner then had to cycle to
// find the meaning the sentence had already settled.
//
// kuromoji reads the surface IN CONTEXT, which is exactly the signal that
// disambiguates — so when a token's reading matches one sense's reading, that sense
// leads. This is a REORDER only: no sense is dropped, the rest keep their relative
// order, and cycling still reaches everything.
//
// Deliberately conservative — it declines to act rather than guess:
//   · fewer than two senses, or no context reading  → nothing to disambiguate
//   · no sense matches the reading                  → the dictionary knew better
//   · EVERY sense matches                           → the reading doesn't separate
//     them (辛い's two つらい senses), so reordering would only churn
// In each case the original order stands, which is the "default to the first" the
// old behaviour already gave.
//
// Mirrors services/language/readingOverrides.ts in shape, but not in kind: that one
// is a capped hand-verified table for NO-CONTEXT single-word lookups, this one is a
// general mechanism driven by the sentence. They never contend — a lookup has no
// context reading, and a reader token isn't a single-word lookup.
// =========================================================

import { foldKana, nfc } from "../../lib/text";

/** Compare readings across script + normalization: コーヒー and こーひー are one reading. */
const sameReading = (a: string, b: string): boolean =>
  foldKana(nfc(a)).trim() === foldKana(nfc(b)).trim();

/**
 * `senses` reordered so the ones matching `contextReading` come first, preserving
 * relative order within each group. Returns the input array unchanged (same
 * reference) whenever there is nothing useful to do — see the header.
 */
export function orderSensesByContextReading<T extends { inputReading: string | null }>(
  senses: T[],
  contextReading: string | null | undefined,
): T[] {
  if (senses.length < 2) return senses;
  const reading = contextReading?.trim();
  if (!reading) return senses;

  const match: T[] = [];
  const rest: T[] = [];
  for (const s of senses) {
    (s.inputReading && sameReading(s.inputReading, reading) ? match : rest).push(s);
  }
  // No discrimination either way → leave the dictionary's ranking alone.
  if (match.length === 0 || rest.length === 0) return senses;
  return [...match, ...rest];
}
