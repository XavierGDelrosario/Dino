// Read-aloud for one surface: availability (async — a device may have no voice for
// the language) plus a play/stop toggle. Every listen button in the app goes
// through this, so the "speaking" affordance behaves the same everywhere.
import { useCallback, useEffect, useRef, useState } from "react";
import { isVoiceAvailable, speak as speakText, cancelSpeech } from "../services/voice";
import type { LangCode } from "../services/language";

export function useSpeak(lang: LangCode): {
  /** False until a voice for `lang` is confirmed — callers render nothing. */
  available: boolean;
  speaking: boolean;
  /** Speak, or stop if this surface is already speaking. */
  speak: (text: string) => void;
} {
  const [available, setAvailable] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  // Mirrors `speaking` for the unmount cleanup, which can't read live state.
  const playing = useRef(false);

  useEffect(() => {
    let live = true;
    void isVoiceAvailable(lang).then((ok) => live && setAvailable(ok));
    return () => {
      live = false;
    };
  }, [lang]);

  // Leaving the surface stops ITS audio (a rated card shouldn't keep talking) —
  // but only if this hook is the one playing. The synthesizer is global, so an
  // unconditional cancel here would cut off a different surface's playback.
  useEffect(
    () => () => {
      if (playing.current) cancelSpeech();
    },
    [],
  );

  const speak = useCallback(
    (text: string) => {
      if (playing.current) {
        cancelSpeech(); // second tap = stop
        return;
      }
      playing.current = true;
      setSpeaking(true);
      void speakText({ text, lang }).finally(() => {
        playing.current = false;
        setSpeaking(false);
      });
    },
    [lang],
  );

  return { available, speaking, speak };
}
