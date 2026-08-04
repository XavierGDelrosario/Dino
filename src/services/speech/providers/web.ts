// =========================================================
// Web Speech API recognizer — the browser half of the speech seam, and the only
// backend that STREAMS today.
//
// Free, no key, no quota, and it does continuous Japanese with interim results,
// which is exactly the live-transcript shape. Two honest caveats, both of which
// argue for the native backend on a phone:
//
//   · NOT on-device. Chrome ships the audio to Google's servers. It costs nothing
//     and needs no infra, but it is neither private nor offline — unlike iOS's
//     SFSpeechRecognizer with requiresOnDeviceRecognition. Treat this as the
//     development and desktop path, not the answer for a phone in someone's pocket.
//   · Chrome (and Chromium/Edge). Safari and Firefox don't implement it usefully,
//     so `available()` is false there and the registry falls through.
//
// THE LOAD-BEARING DETAIL is the restart loop. Chrome ends a recognition session on
// its own — a few seconds of silence, or an internal timeout — and fires `onend`
// even with `continuous = true`. A listener that doesn't restart appears to work in
// testing (someone talking constantly) and dies the moment a conversation pauses,
// which is the whole use case. So `onend` restarts unless the caller stopped, and
// recoverable errors (no-speech, aborted) do the same. Permission errors do not:
// restarting on `not-allowed` would prompt in a loop.
// =========================================================

import type { LangCode } from "../../language";
import type { SpeechRecognizer, SpeechStreamHandle, SpeechStreamOptions } from "../types";

/** App LangCode → BCP-47 speech tag, or null if we don't support it. Mirrors the
 *  native provider's map so the two backends accept the same languages. */
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

// Minimal shape of the vendor-prefixed API — `lib.dom` doesn't declare it.
interface WebSpeechResult {
  readonly isFinal: boolean;
  readonly length: number;
  [index: number]: { transcript: string };
}
interface WebSpeechEvent {
  readonly resultIndex: number;
  readonly results: { readonly length: number; [index: number]: WebSpeechResult };
}
interface WebSpeechRecognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: WebSpeechEvent) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
}
type RecognitionCtor = new () => WebSpeechRecognition;

function ctor(): RecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Errors a long-running session should just restart through. `no-speech` fires on
 *  any quiet stretch, which in a real conversation is constant. */
const RECOVERABLE = new Set(["no-speech", "aborted", "audio-capture-timeout"]);

export const webRecognizer: SpeechRecognizer = {
  id: "web-speech-api",

  available(): boolean {
    return ctor() !== null;
  },

  supports(lang: LangCode): boolean {
    return toSpeechTag(lang) !== null;
  },

  async ensurePermission(): Promise<boolean> {
    // The browser prompts on start() and reports refusal through onerror
    // ("not-allowed"); there is no pre-flight check worth making here.
    return true;
  },

  // One-shot is deliberately NOT implemented: on the web the mic button is gated by
  // the native backend today, and a half-working record-then-fill would be worse
  // than none. Streaming is what this backend exists for.
  async start(): Promise<string[]> {
    return [];
  },

  async stop(): Promise<void> {},

  async startStream({ lang, onPartial, onFinal, onError }: SpeechStreamOptions): Promise<SpeechStreamHandle> {
    const Recognition = ctor();
    const tag = toSpeechTag(lang);
    if (!Recognition || !tag) return { stop: () => {} };

    let stopped = false;
    let recognition: WebSpeechRecognition | null = null;

    const run = () => {
      const r = new Recognition();
      recognition = r;
      r.lang = tag;
      r.continuous = true;
      r.interimResults = true;
      r.maxAlternatives = 1;

      r.onresult = (event) => {
        // Only results from `resultIndex` on are new; earlier ones were already
        // emitted, and re-emitting a final would duplicate it in the transcript.
        let partial = "";
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i];
          const text = result[0]?.transcript ?? "";
          if (!text) continue;
          if (result.isFinal) onFinal(text.trim());
          else partial += text;
        }
        // Always report the partial — including "" — so the in-flight line clears
        // the moment its text is committed instead of lingering under the final.
        onPartial(partial.trim());
      };

      r.onerror = (e) => {
        if (RECOVERABLE.has(e.error)) return; // onend restarts us
        stopped = true; // permission/network: do not loop the prompt
        onError?.(e.error);
      };

      // Chrome ends sessions on its own (silence, internal timeout) even with
      // continuous = true. Restarting is what makes this a listener rather than a
      // dictation box — see the header.
      r.onend = () => {
        if (stopped) return;
        try {
          run();
        } catch (e) {
          onError?.(e);
        }
      };

      r.start();
    };

    run();

    return {
      stop: () => {
        stopped = true;
        recognition?.stop();
        recognition = null;
      },
    };
  },
};
