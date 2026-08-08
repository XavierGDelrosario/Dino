// Dictation: the mic writes STRAIGHT INTO the translate input box.
//
// Writing into the box gets the whole existing surface for free — `useLiveReader`
// already reads it live, so dictated text is coloured, sentence-split and hoverable
// with no new rendering code; the box is EDITABLE, so a mis-heard word or a missing 。
// is fixable; and Translate is the normal button, so the normal PAID gloss applies.
// (This replaced a live-transcript takeover that was free by construction but, for the
// same reason, could never translate anything.)
//
// ⚠️ COST — a deliberate reversal: dictation spends exactly like typing, and speech
// produces text far faster than a keyboard. Bounded by the same paragraphCharLimit and
// monthly quota as any other input, and nothing is spent until Translate is pressed.
//
// The recognizer seam (`services/speech`) is untouched — this is a second consumer of
// the same `startStream` contract.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  isSpeechStreamAvailable,
  startSpeechStream,
  SpeechPermissionError,
  type SpeechStreamHandle,
} from "../services/speech";
import { commitUtterance, withPartial } from "../services/speech/dictation";
import type { LangCode } from "../services/language";
import { errorMessage as message } from "../lib/errorMessage";

export interface UseDictation {
  /** The recognizer can stream this language (gates the mic button). */
  available: boolean;
  listening: boolean;
  /** Set when a session ends badly; cleared on the next start. */
  error: string | null;
  /** Start if idle, stop if listening. */
  toggle: () => void;
  /** DEV ONLY — drive the same callbacks from a scripted conversation. */
  startMock: () => void;
}

export function useDictation({
  lang,
  value,
  onChange,
}: {
  lang: LangCode;
  /** Current box contents — dictation appends to whatever is already there. */
  value: string;
  onChange: (next: string) => void;
}): UseDictation {
  const [available, setAvailable] = useState(false);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handle = useRef<SpeechStreamHandle | null>(null);
  /** A start is awaiting permission//the backend — see `start`. */
  const starting = useRef(false);
  /** Everything committed — the box MINUS any partial currently showing. */
  const base = useRef("");

  // Read through refs inside the recognizer callbacks: they are created once per
  // session and would otherwise close over the value/handler from the render that
  // started it, appending to stale text for the rest of the session.
  const valueRef = useRef(value);
  valueRef.current = value;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    void isSpeechStreamAvailable(lang).then(setAvailable);
  }, [lang]);

  /** The callbacks a recognizer drives. Shared by the real one and the mock. */
  const sink = useCallback(
    () => ({
      lang,
      onPartial: (text: string) => onChangeRef.current(withPartial(base.current, text)),
      onFinal: (text: string) => {
        base.current = commitUtterance(base.current, text);
        onChangeRef.current(base.current);
      },
    }),
    [lang],
  );

  const stop = useCallback(() => {
    // stop() may synchronously commit the half-said line (the native backend does
    // — see tests/services/speech/native.test.ts), so let it run BEFORE settling
    // the box, or that last utterance is dropped.
    handle.current?.stop();
    handle.current = null;
    // Drop any partial still showing: it was never committed, and leaving a
    // half-recognized fragment in the box would read as finished text.
    onChangeRef.current(base.current);
    setListening(false);
  }, []);

  const start = useCallback(async () => {
    // `handle` is only set AFTER the await, so it cannot guard the gap on its own: a
    // second press (or a double-fired tap) during permission//start would open a
    // SECOND recognizer feeding the same box — every utterance committed twice — and
    // leave the first one running with no handle to stop it, so the mic stayed live.
    if (handle.current || starting.current) return;
    starting.current = true;
    setError(null);
    // Continue from what is already in the box — typed, pasted or dictated earlier.
    base.current = valueRef.current;
    try {
      const h = await startSpeechStream({
        ...sink(),
        onError: (e) => {
          setError(typeof e === "string" ? e : message(e));
          handle.current = null;
          setListening(false);
        },
      });
      if (!h) {
        setAvailable(false);
        return;
      }
      handle.current = h;
      setListening(true);
    } catch (e) {
      setError(e instanceof SpeechPermissionError ? "microphone-permission-denied" : message(e));
    } finally {
      starting.current = false;
    }
  }, [sink]);

  const toggle = useCallback(() => {
    if (listening) stop();
    else void start();
  }, [listening, start, stop]);

  /**
   * DEV ONLY — play a scripted conversation through the same callbacks a real
   * recognizer uses, so dictation can be worked on without Chrome and without
   * talking. DYNAMIC import under the DEV flag, not a static one: a static import
   * is bundled whatever the guard says, and a scripted fake conversation shipped to
   * real users is exactly the kind of thing that must not leak.
   */
  const startMock = useCallback(() => {
    if (handle.current || !import.meta.env.DEV) return;
    void import("../services/speech/providers/mock").then(({ mockConversation }) => {
      if (handle.current) return;
      setError(null);
      base.current = valueRef.current;
      handle.current = mockConversation(sink());
      setListening(true);
    });
  }, [sink]);

  // A session must not outlive the screen — the mic would stay open behind a tab.
  useEffect(() => () => handle.current?.stop(), []);

  return { available, listening, error, toggle, startMock };
}
