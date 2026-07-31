// =========================================================
// Native speech recognizer — @capacitor-community/speech-recognition, which uses
// iOS SFSpeechRecognizer (on-device, free, Japanese supported). It's a proper npm
// Capacitor plugin (auto-registered; permissions declared in Info.plist), so this
// is a thin wrapper — no native code of our own. iOS-only today: available() is
// false on web/desktop, so the registry falls through and the mic button hides.
// =========================================================

import { Capacitor, type PluginListenerHandle } from "@capacitor/core";
import { SpeechRecognition } from "@capacitor-community/speech-recognition";
import type { LangCode } from "../../language";
import type { SpeechRecognizer, SpeechStreamHandle, SpeechStreamOptions } from "../types";

/**
 * How long a gap in the partial stream counts as "the speaker finished". Long
 * enough to survive the pause mid-sentence that thinking produces, short enough
 * that a finished line appears while it is still worth reading.
 */
const SILENCE_MS = 1400;
/** Recycle a session that has heard nothing at all — iOS ends the recognition task
 *  by itself after roughly a minute and raises no event to hang the restart on. */
const IDLE_MS = 25_000;

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

  /**
   * CONTINUOUS listening — the live transcript on device, on-device and offline,
   * with no audio leaving the phone (unlike the web backend, which is Chrome
   * shipping audio to Google).
   *
   * The plugin exposes this as `partialResults: true`: start() returns immediately
   * and a `partialResults` event fires with the hypothesis so far, rewritten on
   * every syllable. There is no "final" event — so the UTTERANCE BOUNDARY is the
   * `listeningState` → "stopped" that iOS raises when the speaker pauses. The last
   * partial at that moment IS the finished utterance, and we then restart.
   *
   * That restart is the load-bearing part, exactly as on web: SFSpeechRecognizer
   * ends a session on silence and on its own internal timeout, so without
   * restarting the transcript works while someone talks nonstop and dies the moment
   * a conversation pauses — which is the entire use case.
   */
  async startStream({ lang, onPartial, onFinal, onError }: SpeechStreamOptions): Promise<SpeechStreamHandle> {
    const tag = toSpeechTag(lang);
    if (!tag) return { stop: () => {} };

    let stopped = false;
    let forming = ""; // the most recent partial = the utterance currently being said
    const handles: PluginListenerHandle[] = [];

    // Promote whatever is on the hypothesis into a committed line. Called at the
    // silence boundary and again on stop(), so the sentence in flight is never lost.
    const commit = () => {
      const text = forming.trim();
      forming = "";
      onPartial("");
      if (text) onFinal(text);
    };

    const run = async () => {
      try {
        await SpeechRecognition.start({
          language: tag,
          partialResults: true,
          popup: false, // Android: a system dialog would take over the screen
          maxResults: 1,
        });
      } catch (e) {
        if (!stopped) onError?.(e);
      }
    };

    // THE BOUNDARY IS SELF-DETECTED, not event-driven. The original design waited
    // for `listeningState: "stopped"`, but iOS does not reliably raise it when a
    // dictation session ends on its own — the plugin emits it around explicit
    // start/stop calls, so on device the partials just kept overwriting each other
    // and no line was ever committed. Silence is measured here instead: no new
    // partial for SILENCE_MS means the speaker finished the utterance.
    let cycling = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const arm = (ms: number) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void boundary(), ms);
    };

    /** End the utterance: commit what's formed, then start a fresh session. Both
     *  triggers (the silence timer and the listeningState event, where it does
     *  fire) funnel through here, and `cycling` keeps them from restarting twice. */
    const boundary = async () => {
      if (stopped || cycling) return;
      cycling = true;
      if (timer) clearTimeout(timer);
      commit();
      // Our own stop() re-enters the listeningState listener; `cycling` absorbs it.
      try {
        await SpeechRecognition.stop();
      } catch {
        /* already ended — restarting is what matters */
      }
      if (!stopped) await run();
      cycling = false;
      arm(IDLE_MS);
    };

    handles.push(
      await SpeechRecognition.addListener("partialResults", ({ matches }) => {
        const text = matches?.[0] ?? "";
        if (!text) return;
        forming = text;
        onPartial(text);
        arm(SILENCE_MS); // each syllable pushes the boundary out
      }),
    );
    handles.push(
      await SpeechRecognition.addListener("listeningState", ({ status }) => {
        if (status !== "stopped") return;
        void boundary(); // still honoured on platforms that do raise it
      }),
    );

    await run();
    // A session that never hears anything still has to be recycled: iOS ends the
    // task on its own after about a minute, and nothing would signal that.
    arm(IDLE_MS);

    return {
      stop: () => {
        stopped = true;
        if (timer) clearTimeout(timer);
        commit(); // keep the half-said line rather than dropping it
        void SpeechRecognition.stop().catch(() => {});
        // remove OUR handles, not removeAllListeners() — that would also tear down
        // any listener another part of the app has registered.
        handles.forEach((h) => void h.remove());
        handles.length = 0;
      },
    };
  },
};
