// =========================================================
// Web Speech synthesis backend (window.speechSynthesis). Free, on-device, no key,
// no quota — and it works in the iOS WKWebView too, so this single provider covers
// web AND the Capacitor build.
//
// Three browser quirks are handled here, because each one looks like "our button
// is broken" rather than a platform bug:
//   1. getVoices() is populated ASYNCHRONOUSLY in Chrome — it returns [] until the
//      `voiceschanged` event fires. Reading it once at startup is the classic
//      "works on the second click" bug.
//   2. speak() QUEUES. A second tap would play after the first instead of
//      replacing it, so every speak cancels first.
//   3. Chrome cuts an utterance off at ~15s unless it is nudged. A pause/resume
//      keepalive keeps a pasted paragraph alive; it is a no-op elsewhere.
// =========================================================

import type { LangCode } from "../../language";
import type { VoiceSpeaker } from "../types";

/** App LangCode → BCP-47 voice locale, or null if we don't map it. Mirrors the
 *  same map in services/speech/providers/native.ts (recognition side). */
function toVoiceTag(lang: LangCode): string | null {
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

/** How long to wait for `voiceschanged` before giving up on it — some browsers
 *  never fire it (the list was already complete), so this can't block forever. */
const VOICES_TIMEOUT_MS = 1500;
/** Chrome's long-utterance watchdog interval (quirk 3 above). */
const KEEPALIVE_MS = 10_000;

function synth(): SpeechSynthesis | null {
  return typeof window !== "undefined" && "speechSynthesis" in window ? window.speechSynthesis : null;
}

let pendingVoices: Promise<SpeechSynthesisVoice[]> | null = null;

function loadVoices(): Promise<SpeechSynthesisVoice[]> {
  const s = synth();
  if (!s) return Promise.resolve([]);
  const ready = s.getVoices();
  if (ready.length) return Promise.resolve(ready);
  if (!pendingVoices) {
    pendingVoices = new Promise<SpeechSynthesisVoice[]>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        s.removeEventListener?.("voiceschanged", done);
        resolve(s.getVoices());
      };
      const timer = setTimeout(done, VOICES_TIMEOUT_MS);
      s.addEventListener?.("voiceschanged", done);
      // Nothing arrived → the next call re-reads getVoices(), which short-circuits
      // above once the list is populated.
    }).finally(() => {
      pendingVoices = null;
    });
  }
  return pendingVoices;
}

/** Best voice for a language: exact locale first, then any voice of the same
 *  language (a device may ship only ja-JP-variant or en-GB). */
async function voiceFor(lang: LangCode): Promise<SpeechSynthesisVoice | null> {
  const tag = toVoiceTag(lang);
  if (!tag) return null;
  const wanted = tag.toLowerCase();
  const primary = wanted.split("-")[0];
  // Some platforms report ja_JP with an underscore.
  const norm = (v: SpeechSynthesisVoice) => v.lang.toLowerCase().replace("_", "-");
  const voices = await loadVoices();
  return voices.find((v) => norm(v) === wanted) ?? voices.find((v) => norm(v).startsWith(primary)) ?? null;
}

export const webSpeaker: VoiceSpeaker = {
  id: "web-speech-synthesis",

  available(): boolean {
    return synth() !== null;
  },

  async supports(lang: LangCode): Promise<boolean> {
    return (await voiceFor(lang)) !== null;
  },

  async speak({ text, lang }: { text: string; lang: LangCode }): Promise<void> {
    const s = synth();
    if (!s || !text.trim()) return;
    const voice = await voiceFor(lang);
    s.cancel(); // replace, never queue
    await new Promise<void>((resolve) => {
      const utterance = new SpeechSynthesisUtterance(text);
      if (voice) utterance.voice = voice;
      utterance.lang = voice?.lang ?? toVoiceTag(lang) ?? "";
      const keepalive = setInterval(() => {
        s.pause();
        s.resume();
      }, KEEPALIVE_MS);
      const finish = () => {
        clearInterval(keepalive);
        resolve();
      };
      utterance.onend = finish;
      // A failed utterance must still resolve — the caller's "speaking" state
      // would otherwise stick on forever.
      utterance.onerror = finish;
      s.speak(utterance);
    });
  },

  cancel(): void {
    synth()?.cancel();
  },
};
