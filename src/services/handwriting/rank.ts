// =========================================================
// Candidate re-ranking. ML Kit ranks a single drawn glyph by raw stroke
// similarity, so a simple shape often surfaces PUNCTUATION (、。・…- .) above the
// letter / kanji / kana the learner actually drew. Re-rank so "content" characters
// come first (in ML Kit's original score order) and punctuation-only candidates
// fall to the end.
//
// "Content" = the candidate contains any Unicode letter or number (\p{L} covers
// Latin letters, kanji, kana, hangul; the chōonpu ー is Lm, also a letter, so
// ラーメン-style candidates stay prioritized). A candidate made up only of
// punctuation/symbols (\p{P}/\p{S}) has neither → it sinks. Stable within groups.
// =========================================================

import type { RecognitionCandidate } from "./types";

const CONTENT = /[\p{L}\p{N}]/u;

export function rankCandidates(candidates: RecognitionCandidate[]): RecognitionCandidate[] {
  const content: RecognitionCandidate[] = [];
  const punctuation: RecognitionCandidate[] = [];
  for (const c of candidates) {
    (CONTENT.test(c.text) ? content : punctuation).push(c);
  }
  return [...content, ...punctuation];
}
