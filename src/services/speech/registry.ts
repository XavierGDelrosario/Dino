// =========================================================
// Speech recognizer registry — first available backend wins (mirrors
// handwriting/registry.ts). Only the native iOS backend exists today; a web
// fallback (the Web Speech API, Chrome-only) could slot in after it.
// =========================================================

import type { SpeechRecognizer } from "./types";
import { nativeRecognizer } from "./providers/native";

const RECOGNIZERS: SpeechRecognizer[] = [nativeRecognizer];

// Availability is stable per session (native bridge presence), so probe once and
// reuse the promise instead of re-hitting the Capacitor bridge on every check.
// Mirrors analyze.ts's tokenizerPromise cache.
let resolved: Promise<SpeechRecognizer | null> | null = null;

/** The first usable speech recognizer on this platform, or null (e.g. web today). */
export function resolveRecognizer(): Promise<SpeechRecognizer | null> {
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
