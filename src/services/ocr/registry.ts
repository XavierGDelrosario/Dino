// =========================================================
// OCR recognizer registry — first available backend wins (mirrors
// handwriting/registry.ts). Only the native iOS (Vision) backend exists today; a
// web fallback (Cloud Vision — paid) could slot in after it.
// =========================================================

import type { OcrRecognizer } from "./types";
import { nativeRecognizer } from "./providers/native";

const RECOGNIZERS: OcrRecognizer[] = [nativeRecognizer];

// Availability is stable per session (native bridge presence), so probe once and
// reuse the promise instead of re-hitting the Capacitor bridge on every check.
// Mirrors analyze.ts's tokenizerPromise cache.
let resolved: Promise<OcrRecognizer | null> | null = null;

/** The first usable OCR backend on this platform, or null (e.g. web today). */
export function resolveRecognizer(): Promise<OcrRecognizer | null> {
  if (!resolved) {
    resolved = (async () => {
      for (const r of RECOGNIZERS) {
        if (await r.available()) return r;
      }
      return null;
    })();
  }
  return resolved;
}
