// =========================================================
// Speech recognition seam — mirrors services/handwriting and services/senses: a
// swappable backend the rest of the app never sees.
//
// TWO flows, because they are genuinely different products:
//
//   start()       record → wait for finish → drop the transcript into the translate
//                 input. One shot, final text only.
//
//   startStream() CONTINUOUS listening for the live transcript: partial text while
//                 an utterance forms, a committed string each time one finalizes,
//                 running until stopped. A backend may implement only the first —
//                 startStream is optional and the registry resolves them separately.
//
// The distinction that matters downstream: a one-shot transcript is EDITED by the
// user before anything happens to it, whereas stream output is read as it arrives,
// so each finalized utterance is analyzed on its own and never re-analyzed.
// =========================================================

import type { LangCode } from "../language";

export interface SpeechRecognizer {
  readonly id: string;
  available(): boolean | Promise<boolean>;
  /** Whether this backend can recognize the given language (gates the mic button so
   *  it doesn't show for a language the recognizer can't handle). */
  supports(lang: LangCode): boolean;
  /** Ensure mic + speech permission; resolves false if denied. */
  ensurePermission(): Promise<boolean>;
  /**
   * Start listening. Resolves with the FINAL transcript candidates once
   * recognition ends — which happens on stop() or device end-of-speech. This is
   * the record-then-fill model; partial/streaming results are deliberately not
   * surfaced (live transcription + re-translation is costlier and fights the
   * "translate is an explicit button" design).
   */
  start(opts: { lang: LangCode }): Promise<string[]>;
  /** Force-finish the active recognition (makes start()'s promise resolve). */
  stop(): Promise<void>;
  /**
   * Continuous recognition. Optional: a backend that only does record-then-fill
   * omits it, and `resolveStreamer()` skips over it.
   *
   * `onFinal` fires once per committed utterance and MUST NOT repeat text it has
   * already emitted — the caller appends, it does not diff.
   */
  startStream?(opts: SpeechStreamOptions): Promise<SpeechStreamHandle>;
}

export interface SpeechStreamOptions {
  lang: LangCode;
  /** The utterance currently forming — replaces the previous partial, never appends. */
  onPartial: (text: string) => void;
  /** One committed utterance. Fires once; the caller appends it to the transcript. */
  onFinal: (text: string) => void;
  /** Recognition failed in a way the session can't continue from. */
  onError?: (error: unknown) => void;
}

export interface SpeechStreamHandle {
  /** End the session. Safe to call twice. */
  stop(): void;
}
