// =========================================================
// Speech facade — import from "./speech".
//
//   isSpeechAvailable()      is voice input usable on this platform?
//   startSpeech({ lang })    listen; resolves with final transcript candidates
//   stopSpeech()             force-finish (makes startSpeech resolve)
//   isSpeechStreamAvailable()  can this platform listen CONTINUOUSLY?
//   startSpeechStream({...})   listen until stopped, streaming partial + final text
//
// Record-then-fill: the UI calls startSpeech (awaits), shows a recording state,
// then stopSpeech() ends it; the resolved transcript is appended to the translate
// input. Backends live behind registry.ts (native iOS today); types.ts is the seam.
// =========================================================

import type { LangCode } from "../language";
import type { SpeechRecognizer, SpeechStreamHandle, SpeechStreamOptions } from "./types";
import { resolveRecognizer, resolveStreamer } from "./registry";

/** Thrown by startSpeech when the user has denied mic/speech permission. */
export class SpeechPermissionError extends Error {
  constructor() {
    super("speech-permission-denied");
    this.name = "SpeechPermissionError";
  }
}

// The recognizer currently listening, so stopSpeech() can end it. Only one session
// runs at a time (the mic button is the single entry point).
let active: SpeechRecognizer | null = null;

/** Whether voice input works here (gates the mic button). When `lang` is given,
 *  also requires the backend to support that language. */
export async function isSpeechAvailable(lang?: LangCode): Promise<boolean> {
  const recognizer = await resolveRecognizer();
  if (!recognizer) return false;
  return lang ? recognizer.supports(lang) : true;
}

/** Listen and resolve with the final transcript candidates. Call stopSpeech() to
 *  finish. Throws SpeechPermissionError if permission is denied; [] if no backend. */
export async function startSpeech(opts: { lang: LangCode }): Promise<string[]> {
  const recognizer = await resolveRecognizer();
  if (!recognizer) return [];
  if (!(await recognizer.ensurePermission())) throw new SpeechPermissionError();
  active = recognizer;
  try {
    return await recognizer.start(opts);
  } finally {
    active = null;
  }
}

/** Force-finish the active recognition (makes the pending startSpeech resolve). */
export async function stopSpeech(): Promise<void> {
  await active?.stop();
}

/** Whether CONTINUOUS listening works here (gates the live-transcript surface).
 *  Narrower than isSpeechAvailable: a backend can do record-then-fill and not this. */
export async function isSpeechStreamAvailable(lang?: LangCode): Promise<boolean> {
  const streamer = await resolveStreamer();
  if (!streamer) return false;
  return lang ? streamer.supports(lang) : true;
}

/**
 * Listen continuously, reporting the utterance currently forming (`onPartial`) and
 * each one as it commits (`onFinal`), until the returned handle is stopped.
 *
 * Independent of startSpeech/stopSpeech: this is a different session on a possibly
 * different backend, so a live transcript and the mic button never fight over
 * `active`. Returns null when no backend can stream — the caller hides the surface.
 *
 * Throws SpeechPermissionError if permission is refused up front.
 */
export async function startSpeechStream(
  opts: SpeechStreamOptions,
): Promise<SpeechStreamHandle | null> {
  const streamer = await resolveStreamer();
  if (!streamer?.startStream) return null;
  if (!(await streamer.ensurePermission())) throw new SpeechPermissionError();
  return streamer.startStream(opts);
}

export * from "./types";
