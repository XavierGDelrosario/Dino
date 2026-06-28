// =========================================================
// Camera OCR seam (Mode A) — mirrors services/handwriting and services/speech: a
// swappable backend the rest of the app never sees. Flow: take a photo → recognize
// text + per-block geometry → assemble into reading-order text → feed the existing
// translate input / paragraph reader. So analyze()/translate stay untouched.
//
// Geometry (bounding boxes) is captured even though Mode A only needs the joined
// text — so the future image-overlay (Mode B) can layer on with no re-plumbing.
// =========================================================

import type { LangCode } from "../language";

/** One recognized text region (≈ a line), box NORMALIZED 0..1, TOP-LEFT origin. */
export interface OcrBlock {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A complete recognition: the source image's pixel size + the recognized blocks. */
export interface OcrResult {
  width: number;
  height: number;
  blocks: OcrBlock[];
}

/** A swappable OCR backend. `capture()` takes the photo AND recognizes it (the
 *  camera + the engine are one native round-trip); resolves null if the user
 *  cancels the camera. */
export interface OcrRecognizer {
  readonly id: string;
  available(): boolean | Promise<boolean>;
  /** Whether this backend can recognize the given language (gates the UI affordance). */
  supports(lang: LangCode): boolean;
  capture(opts: { lang: LangCode }): Promise<OcrResult | null>;
}
