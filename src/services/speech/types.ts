// =========================================================
// Speech recognition seam — mirrors services/handwriting and services/senses: a
// swappable backend the rest of the app never sees. The flow is "record → wait
// for finish → drop the transcript into the translate input" (NOT live/streaming:
// see start()), so analyze()/translate stay untouched, same as handwriting/OCR.
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
}
