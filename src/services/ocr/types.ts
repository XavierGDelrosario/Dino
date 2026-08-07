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

/** A photo straight off the camera, before recognition. `base64` carries no data:
 *  URL prefix (that's what the native plugin wants); `format` is the image subtype
 *  ("jpeg"/"png") so the UI can build a data: URL to display it. */
export interface OcrImage {
  base64: string;
  format: string;
}

/**
 * Where the image comes from. `camera` shoots a new one; `library` picks an
 * existing one from the device's photo library.
 *
 * The library matters at least as much as the camera for this app's actual use:
 * a screenshot of a tweet, a manga page, a menu someone sent you — all already ON
 * the phone, and none re-photographable. It is also the only source that works
 * at all on a device with no camera (the simulator).
 */
export type OcrSource = "camera" | "library";

/**
 * A swappable OCR backend.
 *
 * Capture and recognition are SEPARATE steps so the user can crop between them —
 * recognizing the whole photo when they only wanted one line is how a menu's
 * background text ends up in the translate input. `capture()` remains as the
 * combined convenience path for callers that don't crop.
 */
export interface OcrRecognizer {
  readonly id: string;
  available(): boolean | Promise<boolean>;
  /** Whether this backend can recognize the given language (gates the UI affordance). */
  supports(lang: LangCode): boolean;
  /**
   * Get the image only. Resolves null if the user backs out of the camera or picker.
   *
   * `source` is OPTIONAL and defaults to "camera" so this stays source-compatible
   * with backends written before the library existed; a backend that can only do
   * one of the two should still honour the argument or say so in its own docs.
   */
  captureImage(opts?: { source?: OcrSource }): Promise<OcrImage | null>;
  /** Recognize an image (possibly cropped). Null if the language is unsupported. */
  recognizeImage(opts: { base64: string; lang: LangCode }): Promise<OcrResult | null>;
  /** Photo + recognition in one go (no crop step). */
  capture(opts: { lang: LangCode; source?: OcrSource }): Promise<OcrResult | null>;
}
