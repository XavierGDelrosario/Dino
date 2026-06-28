// =========================================================
// Speech recognizer registry — first available backend wins (mirrors
// handwriting/registry.ts). Only the native iOS backend exists today; a web
// fallback (the Web Speech API, Chrome-only) could slot in after it.
// =========================================================

import type { SpeechRecognizer } from "./types";
import { nativeRecognizer } from "./providers/native";

const RECOGNIZERS: SpeechRecognizer[] = [nativeRecognizer];

/** The first usable speech recognizer on this platform, or null (e.g. web today). */
export async function resolveRecognizer(): Promise<SpeechRecognizer | null> {
  for (const r of RECOGNIZERS) {
    if (await r.available()) return r;
  }
  return null;
}
