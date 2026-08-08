// =========================================================
// OCR facade — import from "./ocr".
//
//   isOcrAvailable(lang?)        is camera OCR usable on this platform?
//   capturePhoto({ source })     get a photo ONLY (so the UI can crop it first) —
//                                source "camera" (default) or "library"
//   pickPhoto()                  the same, from the photo library
//   recognizeText({ base64 })    recognize an image → reading-order text
//   captureText({ lang })        take a photo → recognize → reading-order text
//   captureResult({ lang })      same, but the full OcrResult (text + geometry),
//                                for the future image overlay (Mode B)
//
// Mode A: the UI calls capturePhoto, lets the user crop (ImageCropper), then
// recognizeText — and drops the result into the translate input. The uncropped
// captureText path is kept for callers that don't want the crop step. Backends live
// behind registry.ts (native iOS Vision today); types.ts is the seam.
// =========================================================

import type { LangCode } from "../language";
import type { OcrImage, OcrResult, OcrSource } from "./types";
import { resolveRecognizer } from "./registry";
import { blocksToText } from "./readingOrder";

/** Whether camera OCR works here (gates the camera button). When `lang` is given,
 *  also requires the backend to support that language. */
export async function isOcrAvailable(lang?: LangCode): Promise<boolean> {
  const recognizer = await resolveRecognizer();
  if (!recognizer) return false;
  return lang ? recognizer.supports(lang) : true;
}

/** Get a photo WITHOUT recognizing it, so the UI can offer a crop step first —
 *  from the camera (default) or the device's photo library.
 *  Null if the user cancelled or there's no backend. */
export async function capturePhoto(opts: { source?: OcrSource } = {}): Promise<OcrImage | null> {
  const recognizer = await resolveRecognizer();
  if (!recognizer) return null;
  return recognizer.captureImage({ source: opts.source });
}

/** Pick an existing image from the photo library (same crop → recognize path as a
 *  fresh photo). Sugar for `capturePhoto({ source: "library" })` — named because
 *  the call site reads as an intent, not a flag. */
export async function pickPhoto(): Promise<OcrImage | null> {
  return capturePhoto({ source: "library" });
}

/** Recognize an already-captured (possibly cropped) image → blocks + geometry. */
export async function recognizeImage(opts: { base64: string; lang: LangCode }): Promise<OcrResult | null> {
  const recognizer = await resolveRecognizer();
  if (!recognizer) return null;
  return recognizer.recognizeImage(opts);
}

/** Recognize an already-captured image → text in horizontal reading order
 *  (empty string if nothing was recognized / no backend). */
export async function recognizeText(opts: { base64: string; lang: LangCode }): Promise<string> {
  const result = await recognizeImage(opts);
  return result ? blocksToText(result.blocks) : "";
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
export * from "./crop";
