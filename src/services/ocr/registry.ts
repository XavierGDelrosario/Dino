// =========================================================
// OCR recognizer registry — first available backend wins (mirrors
// handwriting/registry.ts). Only the native iOS (Vision) backend exists today; a
// web fallback (Cloud Vision — paid) could slot in after it.
// =========================================================

import type { OcrRecognizer } from "./types";
import { nativeRecognizer } from "./providers/native";

const RECOGNIZERS: OcrRecognizer[] = [nativeRecognizer];

/** The first usable OCR backend on this platform, or null (e.g. web today). */
export async function resolveRecognizer(): Promise<OcrRecognizer | null> {
  for (const r of RECOGNIZERS) {
    if (await r.available()) return r;
  }
  return null;
}
