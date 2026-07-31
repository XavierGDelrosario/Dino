// =========================================================
// The live listener's state: a continuous speech session, with each committed
// utterance analyzed ONCE as it lands.
//
// APPEND-ONLY is the whole design. `useLiveReader` (the typing prototype)
// re-analyzes its text every time it changes, which is fine for a paragraph and
// wrong for a conversation: an hour of talk would re-tokenize and re-look-up
// everything already resolved on every new line. Here each utterance is analyzed
// on arrival and then never touched again; the reader's single-document view is
// assembled by mergeTranscript.
//
// FREE BY CONSTRUCTION, same as the typing path: `dictionaryOnly` + `skipGloss`,
// so a running listener cannot buy MT. Word lookups hit the client cache after
// first sight, so a long conversation converges toward no network at all. English
// for a line the user missed is a separate, deliberate purchase — not built yet.
//
// The recognizer streams; analysis does not block it. A slow lookup delays that
// line's colouring, never the transcript.
// =========================================================
import { useCallback, useEffect, useRef, useState } from "react";
import {
  isSpeechStreamAvailable,
  startSpeechStream,
  SpeechPermissionError,
  type SpeechStreamHandle,
} from "../services/speech";
import { translateParagraph } from "../services/lookup";
import { mergeTranscript, type TranscriptBlock } from "../services/analyze/transcript";
import type { LangCode } from "../services/language";
import { SUPPORTED_LANGUAGES } from "../services/language";
import { errorMessage as message } from "../lib/errorMessage";

export type ListenStatus = "idle" | "listening" | "unavailable" | "error";

export interface TranscriptLine extends TranscriptBlock {
  id: number;
}

export function useLiveTranscript(learning: LangCode) {
  const [status, setStatus] = useState<ListenStatus>("idle");
  const [lines, setLines] = useState<TranscriptLine[]>([]);
  const [partial, setPartial] = useState("");
  const [error, setError] = useState<string | null>(null);
  const handle = useRef<SpeechStreamHandle | null>(null);
  const nextId = useRef(0);

  // The dictionary is keyed learning→native, so a live transcript of the language
  // being studied is looked up against the other one (the same resolution submit
  // makes; asking learning→learning finds nothing).
  const native = SUPPORTED_LANGUAGES.find((l) => l.code !== learning)?.code ?? learning;

  useEffect(() => {
    void isSpeechStreamAvailable(learning).then((ok) => {
      setStatus((prev) => (prev === "listening" ? prev : ok ? "idle" : "unavailable"));
    });
  }, [learning]);

  // Analyze ONE utterance and append it. Errors are swallowed on purpose: an
  // un-analyzed line still belongs in the transcript, just without colour.
  const append = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      const id = nextId.current++;
      // Placed immediately, analyzed after — the transcript must keep up with the
      // speaker even when a lookup is slow.
      setLines((prev) => [...prev, { id, text: trimmed, tokens: [], meanings: new Map() }]);
      void translateParagraph({
        input: trimmed,
        sourceLang: learning,
        targetLang: native,
        skipGloss: true, // no gloss: a listener that auto-translated would bleed quota
        dictionaryOnly: true, // …and never falls through to paid MT
      })
        .then((para) => {
          setLines((prev) =>
            prev.map((l) => (l.id === id ? { ...l, tokens: para.tokens, meanings: para.meanings } : l)),
          );
        })
        .catch(() => {
          /* the line stays, uncoloured */
        });
    },
    [learning, native],
  );

  const stop = useCallback(() => {
    handle.current?.stop();
    handle.current = null;
    setPartial("");
    setStatus((prev) => (prev === "listening" ? "idle" : prev));
  }, []);

  const start = useCallback(async () => {
    if (handle.current) return;
    setError(null);
    try {
      const h = await startSpeechStream({
        lang: learning,
        onPartial: setPartial,
        onFinal: (text) => {
          setPartial("");
          append(text);
        },
        onError: (e) => {
          setError(typeof e === "string" ? e : message(e));
          setStatus("error");
          handle.current = null;
        },
      });
      if (!h) {
        setStatus("unavailable");
        return;
      }
      handle.current = h;
      setStatus("listening");
    } catch (e) {
      setError(e instanceof SpeechPermissionError ? "microphone-permission-denied" : message(e));
      setStatus("error");
    }
  }, [learning, append]);

  /**
   * DEV ONLY — play a scripted conversation through the same callbacks a real
   * recognizer uses, so the transcript can be worked on without Chrome and without
   * talking. Guarded at the call site by import.meta.env.DEV; goes away with the
   * mock provider.
   */
  const startMock = useCallback(async () => {
    if (handle.current) return;
    // DYNAMIC import under the DEV flag, not a static one: a static import is
    // bundled whatever the guard says, and a scripted fake conversation shipped to
    // real users is exactly the kind of thing that must not leak. With the flag
    // false in a production build, Rollup drops the branch and never emits the
    // chunk (verified against dist/).
    if (!import.meta.env.DEV) return;
    const { mockConversation } = await import("../services/speech/providers/mock");
    setError(null);
    handle.current = mockConversation({
      lang: learning,
      onPartial: setPartial,
      onFinal: (text) => {
        setPartial("");
        append(text);
      },
    });
    setStatus("listening");
  }, [learning, append]);

  const clear = useCallback(() => {
    setLines([]);
    setPartial("");
  }, []);

  // A session must not outlive the screen — the mic would stay open.
  useEffect(() => () => handle.current?.stop(), []);

  return {
    status,
    listening: status === "listening",
    lines,
    partial,
    error,
    /** The whole transcript as one document for the reader (see mergeTranscript). */
    merged: mergeTranscript(lines),
    start,
    startMock,
    stop,
    clear,
  };
}
