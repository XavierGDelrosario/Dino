// =========================================================
// Dictation: the mic writes STRAIGHT INTO the translate input box.
//
// This replaces the live-transcript takeover (`useLiveTranscript` +
// `LiveTranscriptView`), which was deleted with it. That screen rendered its own
// parallel reader over an append-only list of utterances and was, by construction,
// unable to translate anything: it passed `skipGloss` + `dictionaryOnly` so a
// running listener could never buy MT, and the "purchase English for this line"
// path it assumed was never built. So it coloured words and nothing else.
//
// Writing into the box instead gets the whole existing surface for free:
//   · `useLiveReader` already reads the box live — dictated text is coloured,
//     sentence-split and hoverable with no new rendering code at all;
//   · the box is EDITABLE, so a mis-heard word or a missing 。 is fixable, which a
//     streaming transcript never allowed;
//   · Translate is the normal button, so the normal PAID gloss applies.
//
// ⚠️ COST — this is a deliberate reversal. The old listener could run for an hour
// and never spend: it was free by construction. Dictation spends exactly like
// typing does, and speech produces text far faster than a keyboard. That is bounded
// by the same `paragraphCharLimit` + monthly quota as any other input, and nothing
// is spent until Translate is pressed — but it IS a change, not an oversight.
//
// The recognizer seam (`services/speech`) is untouched: this is a second consumer
// of the same `startStream` contract the transcript used.
// =========================================================
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
    if (handle.current) return;
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
