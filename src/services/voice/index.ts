// =========================================================
// Voice (text-to-speech) facade — import from "./voice".
//
//   isVoiceAvailable(lang?)   can this platform pronounce that language?
//   speak({ text, lang })     say it; resolves when playback ends
//   cancelSpeech()            stop immediately
//   pronounceableText(word)   WHICH text to speak for a word (see pronounce.ts)
//
// Output-only and free: no permission, no key, no quota, no persistence — the
// opposite of the recognition modalities next door. `lang` is the language of the
// TEXT, never the UI locale: speaking a Japanese term with an English voice
// produces phonetic gibberish.
// =========================================================

import type { LangCode } from "../language";
import type { VoiceSpeaker } from "./types";
import { resolveSpeaker } from "./registry";

// The speaker currently playing, so cancelSpeech() can stop it synchronously.
// One utterance plays at a time by construction (speak() cancels first).
let active: VoiceSpeaker | null = null;

/** Whether speech output works here (gates every listen button). With `lang`, also
 *  requires a voice for that language — a device with no Japanese voice would
 *  otherwise show a button that plays nothing. */
export async function isVoiceAvailable(lang?: LangCode): Promise<boolean> {
  const speaker = await resolveSpeaker();
  if (!speaker) return false;
  return lang ? await speaker.supports(lang) : true;
}

/** Speak `text` in `lang`, resolving when playback ends. No-op without a backend. */
export async function speak(opts: { text: string; lang: LangCode }): Promise<void> {
  const speaker = await resolveSpeaker();
  if (!speaker) return;
  active = speaker;
  try {
    await speaker.speak(opts);
  } finally {
    if (active === speaker) active = null;
  }
}

/** Stop playback now (makes a pending speak() resolve). Safe when nothing plays. */
export function cancelSpeech(): void {
  active?.cancel();
}

export * from "./types";
export { pronounceableText, type SpeakableWord } from "./pronounce";
