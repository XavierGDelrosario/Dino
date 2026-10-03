// =========================================================
// Candidate clean-up. ML Kit ranks a single drawn glyph by raw stroke similarity,
// so a simple shape often surfaces PUNCTUATION (、。・…- .) above — or attached to —
// the letter / kanji / kana the learner actually drew. The pad exists to enter a
// character you can see but can't type, and punctuation is always typeable, so it
// is IGNORED outright: a punctuation-only candidate is dropped, and punctuation
// riding on a real one (日。) is stripped off it.
//
// "Content" = any Unicode letter or number (\p{L} covers Latin letters, kanji,
// kana, hangul; the chōonpu ー is Lm, also a letter, so ラーメン-style candidates
// survive intact). Order is ML Kit's own; a candidate that stripping turns into a
// duplicate of a better-ranked one is dropped.
// =========================================================

import type { RecognitionCandidate } from "./types";

const NON_CONTENT = /[^\p{L}\p{N}]/gu;

export function rankCandidates(candidates: RecognitionCandidate[]): RecognitionCandidate[] {
  const out: RecognitionCandidate[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    const text = c.text.replace(NON_CONTENT, "");
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text === c.text ? c : { ...c, text });
  }
  return out;
}
