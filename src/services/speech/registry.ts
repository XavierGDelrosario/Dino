// =========================================================
// Speech recognizer registry — first available backend wins (mirrors
// handwriting/registry.ts). Native iOS first (on-device, private, offline), then
// the Web Speech API for the browser.
//
// TWO LISTS, not one, because the capabilities genuinely differ. Native does
// record-then-fill; only the web backend streams. A single list would put the web
// backend behind the MIC BUTTON on desktop — where its one-shot start() is a stub —
// so the button would appear and do nothing. Keeping them apart means the live
// transcript works in the browser while the mic button stays native-only.
//
// Native is listed first in BOTH: when it grows a startStream (SFSpeechRecognizer
// with partial results, or iOS 26's SpeechTranscriber) it wins streaming too, on
// device and offline, with no caller change.
// =========================================================

import type { SpeechRecognizer } from "./types";
import { nativeRecognizer } from "./providers/native";
import { webRecognizer } from "./providers/web";

/** Record-then-fill backends (the mic button). Native only — see the header. */
const RECOGNIZERS: SpeechRecognizer[] = [nativeRecognizer];

/** Continuous backends (the live transcript). */
const STREAMERS: SpeechRecognizer[] = [nativeRecognizer, webRecognizer];

/** The first usable one-shot recognizer on this platform, or null (web today). */
export async function resolveRecognizer(): Promise<SpeechRecognizer | null> {
  for (const r of RECOGNIZERS) {
    if (await r.available()) return r;
  }
  return null;
}

/** The first backend that can run a CONTINUOUS session, or null. */
export async function resolveStreamer(): Promise<SpeechRecognizer | null> {
  for (const r of STREAMERS) {
    if (r.startStream && (await r.available())) return r;
  }
  return null;
}
