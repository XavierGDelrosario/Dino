// EXPERIMENT — the reader, live under the input: the same analysis Translate runs, but
// WHILE you type, so the colouring is there before you ask for anything.
//
// Three rules keep it from being expensive or annoying:
//
// 1. FREE ONLY. `dictionaryOnly`, so a word the dictionary lacks comes back empty
//    instead of falling through to paid MT — typing 唐揚げ passes through 唐 and 唐揚 on
//    the way, and neither is worth billing for. The gloss stays behind the reader's
//    own toggle, paid for only when someone asks.
//
// 2. COMPLETE SENTENCES ONLY. Analyzing the trailing, still-being-typed sentence would
//    re-tokenize on every keystroke and make the text twitch under the cursor as
//    segmentation changes its mind. Finished text stops moving, which is what makes
//    it readable.
//
// 3. NOT WHILE COMPOSING. A Japanese IME holds intermediate kana mid-conversion, and
//    tokenizing that flickers garbage. Same reason submit is a button, never Enter.
//
// The explicit Translate button is untouched: this is ambient reading, that is the
// deliberate act.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { translateParagraph, type ParagraphTranslation } from "../services/lookup";
import { splitSentences, SUPPORTED_LANGUAGES, resolveSourceLanguage } from "../services/language";
import { glossSentences, getCachedGloss } from "../services/translation";
import type { LangCode } from "../services/language";
import type { SourceSelection } from "../services/language/detect";
import { nfc } from "../lib/text";

/** Idle time before analysis runs: long enough that a typing burst is one pass, short
 *  enough that a pause feels answered. */
const DEBOUNCE_MS = 500;

/** Below this there's nothing worth colouring, and a one-word input belongs to the
 *  single-word path anyway. */
const MIN_CHARS = 4;

/** The text that is DONE being typed: everything up to the last sentence terminator.
 *  "" when no sentence has been finished yet. PURE. */
export function completedPrefix(text: string): string {
  const spans = splitSentences(text);
  if (spans.length === 0) return "";
  const last = spans[spans.length - 1];
  // A final span running to the end of the input with no terminator after it is the
  // sentence currently being typed — drop it.
  //
  // A HARD LINE BREAK counts as a terminator, as it does in `splitSentences`: dictation
  // commits each utterance with a trailing "\n" and never a 。, so a punctuation-only
  // test left the reader one utterance behind and showed nothing for a single spoken
  // line. The span text is trimmed, so the break lives in the source AFTER the span.
  const terminated =
    /[。．！？!?…]\s*$/u.test(text.slice(last.start, last.end)) || text.slice(last.end).includes("\n");
  const end = terminated ? last.end : spans.length > 1 ? spans[spans.length - 2].end : 0;
  return text.slice(0, end);
}

export function useLiveReader({
  text,
  source,
  learning,
  enabled = true,
}: {
  text: string;
  /** The input box's source selection (may be auto-detect). */
  source: SourceSelection;
  /** The language being STUDIED — what the reader colours. */
  learning: LangCode;
  enabled?: boolean;
}): {
  /** The live analysis, or null when there is nothing complete to show yet. */
  para: ParagraphTranslation | null;
  /** The exact text `para` describes (the reader needs it to slice spans). */
  analyzed: string;
  loading: boolean;
  /** Buy the English for ONE sentence (the reader's punctuation affordance). */
  translateSentence: (index: number) => Promise<void>;
  /** Buy it for the whole analyzed text — cache-aware, so tapped lines are free. */
  translateAll: () => Promise<void>;
  glossLoading: boolean;
  /** Wire to the input's compositionstart/end — analysis pauses mid-conversion. */
  setComposing: (composing: boolean) => void;
} {
  const [para, setPara] = useState<ParagraphTranslation | null>(null);
  const [analyzed, setAnalyzed] = useState("");
  const [loading, setLoading] = useState(false);
  const [composing, setComposing] = useState(false);
  // The request currently in flight; a later one supersedes it (the user kept
  // typing), so a slow response can never overwrite a newer analysis.
  const latest = useRef(0);

  // The lookup pair, resolved exactly as submit resolves it: the dictionary is keyed
  // learning→native, and asking learning→learning finds nothing (which rendered a
  // reader with every word grey).
  const resolved = resolveSourceLanguage(text, source);
  const typedLearning = resolved === learning;
  const native = SUPPORTED_LANGUAGES.find((l) => l.code !== learning)?.code ?? learning;

  // ONLY when typing the language being studied. The other direction would need an MT
  // call to reach the learning language first, and this path exists because it never
  // spends — so it stays quiet and the Translate button handles that.
  const target = enabled && typedLearning && !composing ? nfc(completedPrefix(text)) : "";

  useEffect(() => {
    // Below the floor nothing is analyzed, but whatever is rendered STAYS — clearing
    // here would blink the reader out at the start of every new sentence. The
    // empty-input effect below is what resets it.
    if (target.length < MIN_CHARS) return;
    if (target === analyzed) return; // already analyzed this exact prefix

    const seq = ++latest.current;
    const timer = setTimeout(() => {
      setLoading(true);
      translateParagraph({
        input: target,
        sourceLang: learning,
        targetLang: native,
        skipGloss: true, // the gloss is the paid part — the reader's toggle buys it
        dictionaryOnly: true, // …and a half-typed word never buys anything at all
      })
        .then((result) => {
          if (seq !== latest.current) return; // superseded
          setPara(result);
          setAnalyzed(target);
        })
        .catch(() => {
          /* non-fatal: the input keeps working, it just isn't coloured */
        })
        .finally(() => {
          if (seq === latest.current) setLoading(false);
        });
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [target, analyzed, learning, native]);

  // A cleared input clears the reader — otherwise the last paragraph hangs around
  // under an empty box.
  useEffect(() => {
    if (text.trim() === "") {
      latest.current++;
      setPara(null);
      setAnalyzed("");
      setLoading(false);
    }
  }, [text]);

  // ── Buying the English ────────────────────────────────────────────────────
  // Tap one sentence or take the lot; buying either way makes the other free, in either
  // order. The gloss is read STRAIGHT FROM THE CACHE rather than held in state, because
  // this text is still being typed: spans are re-split on every keystroke, so anything
  // keyed by INDEX would smear onto the wrong line, while the cache is keyed by the
  // sentence text itself. `bought` exists only to re-render after a purchase.
  const [bought, setBought] = useState(0);
  const [glossLoading, setGlossLoading] = useState(false);

  const withGlosses = useMemo(() => {
    if (!para) return null;
    void bought; // re-read the cache after a purchase
    const sentences = para.sentences.map((s) => ({
      ...s,
      gloss: s.gloss ?? getCachedGloss(s.text, learning, native) ?? null,
    }));
    return { ...para, sentences };
  }, [para, bought, learning, native]);

  const translateSentence = useCallback(
    async (index: number) => {
      const span = para?.sentences[index];
      if (!span || getCachedGloss(span.text, learning, native)) return;
      await glossSentences({ segments: [span.text], sourceLang: learning, targetLang: native });
      setBought((n) => n + 1);
    },
    [para, learning, native],
  );

  const translateAll = useCallback(async () => {
    const spans = para?.sentences ?? [];
    if (glossLoading || spans.length === 0) return;
    setGlossLoading(true);
    try {
      await glossSentences({
        segments: spans.map((s) => s.text),
        sourceLang: learning,
        targetLang: native,
      });
      setBought((n) => n + 1);
    } finally {
      setGlossLoading(false);
    }
  }, [para, glossLoading, learning, native]);

  return {
    para: withGlosses,
    analyzed,
    loading,
    translateSentence,
    translateAll,
    glossLoading,
    setComposing: useCallback((v: boolean) => setComposing(v), []),
  };
}
