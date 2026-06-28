// =========================================================
// Speech facade — import from "./speech".
//
//   isSpeechAvailable()      is voice input usable on this platform?
//   startSpeech({ lang })    listen; resolves with final transcript candidates
//   stopSpeech()             force-finish (makes startSpeech resolve)
//
// Record-then-fill: the UI calls startSpeech (awaits), shows a recording state,
// then stopSpeech() ends it; the resolved transcript is appended to the translate
// input. Backends live behind registry.ts (native iOS today); types.ts is the seam.
// =========================================================

import type { LangCode } from "../language";
import type { SpeechRecognizer } from "./types";
import { resolveRecognizer } from "./registry";

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

export * from "./types";
