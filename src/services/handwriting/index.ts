// =========================================================
// Handwriting facade — import from "./handwriting".
//
//   recognizeHandwriting(ink)   strokes → ranked text candidates
//   isHandwritingAvailable()    is any backend usable on this platform?
//
// Backends live behind registry.ts (native iOS ML Kit today); types.ts is the
// seam. Callers only ever see strokes-in / text-out — the recognized text feeds
// the normal translate input, so the rest of the app is untouched.
// =========================================================

import type { LangCode } from "../language";
import type { InkInput, RecognitionCandidate } from "./types";
import { resolveRecognizer } from "./registry";
import { rankCandidates } from "./rank";

/** Recognize a drawing into ranked candidates (letters/kanji first, punctuation
 *  last). Empty strokes or no available backend → [] (graceful: the UI just shows
 *  "no match" / hides the feature). */
export async function recognizeHandwriting(ink: InkInput): Promise<RecognitionCandidate[]> {
  if (ink.strokes.length === 0) return [];
  const recognizer = await resolveRecognizer();
  if (!recognizer) return [];
  return rankCandidates(await recognizer.recognize(ink));
}

/** Whether handwriting works here (gates the draw affordance). When `lang` is given,
 *  also requires the backend to support that language — so the button never shows
 *  for a language the recognizer can't handle. */
export async function isHandwritingAvailable(lang?: LangCode): Promise<boolean> {
  const recognizer = await resolveRecognizer();
  if (!recognizer) return false;
  return lang ? recognizer.supports(lang) : true;
}

export * from "./types";
