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
/** How often to check that the recognizer is still alive. iOS ends the task by
 *  itself after roughly a minute and raises no event to hang a restart on, so the
 *  STATE is polled — cheap, and it never disturbs a healthy session. */
const HEALTH_MS = 5_000;
/** Breathing room between stopping and starting the recognizer. Doing the two
 *  back-to-back rebuilds AVAudioEngine under a task that is still finishing, and
 *  the native exception takes the whole app down. */
const RESTART_DELAY_MS = 400;

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
    let forming = ""; // the utterance being said right now (not yet a line)
    let heard = ""; // the engine's FULL hypothesis for the current session
    let committed = ""; // the part of `heard` already promoted to lines
    const handles: PluginListenerHandle[] = [];

    // Promote whatever is on the hypothesis into a committed line. Called at the
    // silence boundary and again on stop(), so the sentence in flight is never lost.
    const commit = () => {
      const text = forming.trim();
      forming = "";
      onPartial("");
      if (!text) return;
      onFinal(text);
      // Everything the engine has produced so far is now a line. iOS keeps ONE
      // hypothesis running across a pause rather than starting a new one, so the
      // next partial arrives with all of this still prefixed to it — without this
      // mark, every committed sentence would be re-emitted inside the next.
      committed = heard;
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

    // THE BOUNDARY IS SELF-DETECTED, AND IT DOES NOT TOUCH THE SESSION.
    //
    // Two things were learned on device, in this order. First, `listeningState:
    // "stopped"` is not raised when iOS ends a dictation session on silence (the
    // plugin emits it around explicit start/stop calls), so waiting for it meant
    // partials overwrote each other and no line was ever committed. Silence is
    // therefore measured here, from the gap between partials.
    //
    // Second — and this is why the boundary only COMMITS — stopping and restarting
    // the recognizer at each pause CRASHED THE APP: `stop()` immediately followed by
    // `start()` tears down and rebuilds AVAudioEngine underneath a task that is
    // still finishing, and the native exception kills the process. That path had
    // never actually run before, because the event that triggered it never fired.
    //
    // So a pause now ends the LINE, not the session: the recognizer keeps running,
    // its hypothesis keeps growing, and `committed` marks how much of it is already
    // on screen. Restarting is reserved for a session that is genuinely dead, and
    // even then it is done gently (see `restart`).
    let cycling = false;
    let silence: ReturnType<typeof setTimeout> | null = null;
    let health: ReturnType<typeof setInterval> | null = null;

    const armSilence = () => {
      if (silence) clearTimeout(silence);
      silence = setTimeout(commit, SILENCE_MS);
    };

    /** Bring a DEAD session back. Never called for an ordinary pause. */
    const restart = async () => {
      if (stopped || cycling) return;
      cycling = true;
      if (silence) clearTimeout(silence);
      commit(); // don't lose the line in flight
      heard = "";
      committed = ""; // a new session starts a new hypothesis
      try {
        // Only stop something that is actually listening, and give the audio
        // session time to tear down before starting again — doing the two
        // back-to-back is what crashed the app.
        if ((await SpeechRecognition.isListening()).listening) {
          await SpeechRecognition.stop();
          await new Promise((r) => setTimeout(r, RESTART_DELAY_MS));
        }
      } catch {
        /* already gone — starting again is what matters */
      }
      if (!stopped) await run();
      cycling = false;
    };

    handles.push(
      await SpeechRecognition.addListener("partialResults", ({ matches }) => {
        const full = matches?.[0] ?? "";
        if (!full) return;
        heard = full;
        // Strip what is already on screen: iOS extends ONE hypothesis across a
        // pause, so without this every committed sentence would reappear inside
        // the next one.
        const rest = (full.startsWith(committed) ? full.slice(committed.length) : full).trim();
        if (!rest) return;
        forming = rest;
        onPartial(rest);
        armSilence(); // each syllable pushes the line boundary out
      }),
    );
    handles.push(
      await SpeechRecognition.addListener("listeningState", ({ status }) => {
        // Where a platform DOES raise this, the session really has ended.
        if (status === "stopped" && !cycling) void restart();
      }),
    );

    await run();

    // The only other way a session dies is quietly: iOS ends the task on its own
    // after about a minute, and after an error. Poll for that rather than assuming
    // an event — but poll the STATE, so a healthy session is never disturbed.
    health = setInterval(() => {
      if (stopped || cycling) return;
      void SpeechRecognition.isListening()
        .then(({ listening }) => {
          if (!listening) void restart();
        })
        .catch(() => {
          /* the check itself failing is not worth killing the session over */
        });
    }, HEALTH_MS);

    return {
      stop: () => {
        stopped = true;
        if (silence) clearTimeout(silence);
        if (health) clearInterval(health);
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
