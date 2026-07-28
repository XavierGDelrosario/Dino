// =========================================================
// Text-to-speech seam — mirrors services/speech (recognition), handwriting and
// ocr: a swappable backend the rest of the app never sees. Unlike those, the WEB
// backend is the good one — speechSynthesis is free, on-device and present in
// every modern browser INCLUDING the iOS WKWebView Capacitor runs, so there is no
// native provider today. One would only be worth adding for what the web API
// can't reach: the iOS audio-session category, which decides whether the hardware
// silent switch mutes playback.
//
// Read-only by nature: nothing here is persisted, billed, or permission-gated.
// =========================================================

import type { LangCode } from "../language";

export interface VoiceSpeaker {
  readonly id: string;
  /** Is this backend usable at all on this platform? */
  available(): boolean | Promise<boolean>;
  /** Can it actually pronounce this language? A platform with no Japanese voice
   *  reports false, which is what hides the button rather than playing silence. */
  supports(lang: LangCode): boolean | Promise<boolean>;
  /** Speak `text`, resolving when playback ends (or fails). Replaces whatever is
   *  currently playing — utterances queue by default, which is never what a
   *  tap-to-hear button means. */
  speak(opts: { text: string; lang: LangCode }): Promise<void>;
  /** Stop immediately (makes a pending speak() resolve). */
  cancel(): void;
}
