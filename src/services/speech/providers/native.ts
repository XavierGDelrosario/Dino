// =========================================================
// Native speech recognizer — @capacitor-community/speech-recognition, which uses
// iOS SFSpeechRecognizer (on-device, free, Japanese supported). It's a proper npm
// Capacitor plugin (auto-registered; permissions declared in Info.plist), so this
// is a thin wrapper — no native code of our own. iOS-only today: available() is
// false on web/desktop, so the registry falls through and the mic button hides.
// =========================================================

import { Capacitor } from "@capacitor/core";
import { SpeechRecognition } from "@capacitor-community/speech-recognition";
import type { LangCode } from "../../language";
import type { SpeechRecognizer } from "../types";

/** App LangCode → BCP-47 speech locale, or null if we don't support it. */
function toSpeechTag(lang: LangCode): string | null {
  switch (lang.toUpperCase()) {
    case "JA":
      return "ja-JP";
    case "EN":
      return "en-US";
    case "KO":
      return "ko-KR";
    case "ZH":
      return "zh-CN";
    default:
      return null;
  }
}

export const nativeRecognizer: SpeechRecognizer = {
  id: "capacitor-speech-recognition",

  async available(): Promise<boolean> {
    if (!Capacitor.isNativePlatform()) return false;
    try {
      return (await SpeechRecognition.available()).available;
    } catch {
      return false;
    }
  },

  supports(lang: LangCode): boolean {
    return toSpeechTag(lang) !== null;
  },

  async ensurePermission(): Promise<boolean> {
    const status = await SpeechRecognition.checkPermissions();
    if (status.speechRecognition === "granted") return true;
    const requested = await SpeechRecognition.requestPermissions();
    return requested.speechRecognition === "granted";
  },

  async start({ lang }): Promise<string[]> {
    const tag = toSpeechTag(lang);
    if (!tag) return [];
    // partialResults:false → the promise resolves with the FINAL transcript once
    // recognition ends (we end it via stop()) — the record-then-fill flow.
    const res = await SpeechRecognition.start({
      language: tag,
      partialResults: false,
      maxResults: 1,
    });
    return res.matches ?? [];
  },

  async stop(): Promise<void> {
    await SpeechRecognition.stop();
  },
};
