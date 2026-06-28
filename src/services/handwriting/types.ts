// =========================================================
// Handwriting recognition seam — the types every backend shares.
//
// The whole feature is "strokes in → candidate text out": a learner draws a
// character they can SEE but can't type (a kanji), the recognizer returns ranked
// text guesses, and the chosen one flows into the normal translate input — so
// analyze()/JMdict/the edge function never know handwriting happened (just like
// speech/OCR will). The recognizer BACKEND is platform-specific (on-device ML Kit
// on iOS today; a web fallback could slot in later) and hides entirely behind
// HandwritingRecognizer, mirroring the senses/ and difficulty/ provider seams.
// =========================================================

import type { LangCode } from "../language";

/** One sampled pen point in the writing area's pixel space. `t` = ms since the
 *  stroke's first point (optional — ML Kit uses timing as a hint, works without). */
export interface InkPoint {
  x: number;
  y: number;
  t?: number;
}

/** One continuous pen-down…pen-up trace. */
export interface Stroke {
  points: InkPoint[];
}

/** A complete drawing handed to a recognizer. width/height describe the writing
 *  area in the SAME coordinate space as the points, so a backend can normalize. */
export interface InkInput {
  strokes: Stroke[];
  width: number;
  height: number;
  /** Language to recognize in (the SOURCE side — what the drawing becomes). */
  lang: LangCode;
}

/** A ranked guess. `score` is backend-specific (higher = better) and may be absent. */
export interface RecognitionCandidate {
  text: string;
  score?: number;
}

/** A swappable recognizer backend. `available()` lets the registry pick the first
 *  usable one at runtime (native plugin present? online?), so the UI can hide the
 *  draw affordance entirely when nothing can recognize on this platform. */
export interface HandwritingRecognizer {
  readonly id: string;
  available(): boolean | Promise<boolean>;
  /** Whether this backend can recognize the given language (gates the UI affordance
   *  so it doesn't show for a language the recognizer can't handle). */
  supports(lang: LangCode): boolean;
  recognize(input: InkInput): Promise<RecognitionCandidate[]>;
}
