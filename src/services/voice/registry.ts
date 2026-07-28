// =========================================================
// Speaker registry — first available backend wins (mirrors speech/handwriting/ocr).
// Only the web backend exists, and it covers the native build too (the iOS
// WKWebView implements speechSynthesis). A native provider would slot in BEFORE
// this one if we ever need the iOS audio-session control the web API lacks.
// =========================================================

import type { VoiceSpeaker } from "./types";
import { webSpeaker } from "./providers/web";

const SPEAKERS: VoiceSpeaker[] = [webSpeaker];

/** The first usable speaker on this platform, or null (e.g. a non-browser runtime). */
export async function resolveSpeaker(): Promise<VoiceSpeaker | null> {
  for (const s of SPEAKERS) {
    if (await s.available()) return s;
  }
  return null;
}
