// =========================================================
// OCR facade — import from "./ocr".
//
//   isOcrAvailable(lang?)        is camera OCR usable on this platform?
//   captureText({ lang })        take a photo → recognize → reading-order text
//   captureResult({ lang })      same, but the full OcrResult (text + geometry),
//                                for the future image overlay (Mode B)
//
// Mode A: the UI calls captureText, drops the result into the translate input, and
// submits — the existing paragraph reader does the rest. Backends live behind
// registry.ts (native iOS Vision today); types.ts is the seam.
// =========================================================

import type { LangCode } from "../language";
import type { OcrResult } from "./types";
import { resolveRecognizer } from "./registry";
import { blocksToText } from "./readingOrder";

/** Whether camera OCR works here (gates the camera button). When `lang` is given,
 *  also requires the backend to support that language. */
export async function isOcrAvailable(lang?: LangCode): Promise<boolean> {
  const recognizer = await resolveRecognizer();
  if (!recognizer) return false;
  return lang ? recognizer.supports(lang) : true;
}

/** Take a photo and return the recognized blocks + geometry, or null if cancelled
 *  / no backend. */
export async function captureResult(opts: { lang: LangCode }): Promise<OcrResult | null> {
  const recognizer = await resolveRecognizer();
  if (!recognizer) return null;
  return recognizer.capture(opts);
}

/** Mode A: take a photo and return the recognized text in horizontal reading order
 *  (empty string if cancelled / nothing recognized). */
export async function captureText(opts: { lang: LangCode }): Promise<string> {
  const result = await captureResult(opts);
  if (!result) return "";
  return blocksToText(result.blocks);
}

export * from "./types";
