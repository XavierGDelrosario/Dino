// =========================================================
// Recognizer registry — picks the first AVAILABLE backend at runtime.
//
// Mirrors services/senses/registry.ts: an ordered list, first match wins. Only
// the native (iOS ML Kit) backend exists today; a web fallback (e.g. the Google
// input-tools ink endpoint, or canvas→OCR) would slot in AFTER it so on-device
// recognition always wins when present. The UI calls resolveRecognizer() (via the
// facade's isHandwritingAvailable) to decide whether to show the draw affordance.
// =========================================================

import type { HandwritingRecognizer } from "./types";
import { nativeRecognizer } from "./providers/native";

const RECOGNIZERS: HandwritingRecognizer[] = [nativeRecognizer];

// Availability is a stable property of the platform (native bridge presence), so
// probe once and reuse the promise — the UI calls resolveRecognizer() on every
// keystroke/affordance check and each probe hits the Capacitor bridge otherwise.
// Mirrors analyze.ts's tokenizerPromise cache.
let resolved: Promise<HandwritingRecognizer | null> | null = null;

/** The first usable recognizer on this platform, or null if none (e.g. web today). */
export function resolveRecognizer(): Promise<HandwritingRecognizer | null> {
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
