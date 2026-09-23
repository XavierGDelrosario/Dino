// =========================================================
// Turn a sense's curated PROSE into something the READER can render — the example
// sentence AND the monolingual definition beside it.
//
// The corpus stores an example as plain text. The whole design intent is that it renders
// through ParagraphReader — every word in it furigana'd, coloured by what the user
// already knows, and addable — so the sentence under a word is itself a way in to more
// words ("the rabbit hole is the FEATURE", docs/TODO.md). That needs three things the
// stored string doesn't carry: kuromoji tokens, a meaning list per word, and the user's
// own saved/confidence state for those senses.
//
// BOTH PIECES, ONE KNOWLEDGE STATE. `definition_source` is a definition of the sense IN
// THE SOURCE LANGUAGE (20260752 renamed it from definition_ja for exactly that reason),
// so on a JA→EN row it is Japanese prose sitting directly under a Japanese sentence —
// often the denser and more interesting of the two. Rendering one through the reader and
// the other as a dead <p> made the panel contradict itself.
//
// They share ONE saved/confidence set rather than running the hook twice, and that is
// not just economy: a word occurring in both must not be blue in the definition and
// green in the example after you add it from one of them.
//
// LAZY BY CONSTRUCTION. Nothing runs until a row's panel is actually opened (`active`),
// because a Lists page renders dozens of rows and analysing every example on mount would
// load kuromoji and fan out lookups for sentences nobody asked to see. Once loaded it
// stays loaded — reopening the same row is instant.
//
// COSTS NOTHING. `skipGloss` (the English is already authored, so there is no paragraph
// to translate) plus `dictionaryOnly` (a word JMdict lacks comes back with no meanings
// rather than falling through to paid MT). Opening an example must never bill Google —
// it is a reference surface, not a translation request. That holds per PIECE, so adding
// the definition added lookups and no spend.
// =========================================================
import { useCallback, useEffect, useRef, useState } from "react";
import { translateParagraph } from "../services/lookup";
import { getUserWordStates, saveDictionaryWords } from "../services/words/userWords";
import { listUserLists, createList, type List } from "../services/lists";
import type { AnalyzedToken, LangCode } from "../services/language";
import type { Word } from "../services/words/repository";

/** One analyzed piece of prose — everything ParagraphReader needs for ONE `text`. */
export interface SenseExamplePart {
  tokens: AnalyzedToken[];
  meaningsByWord: Map<string, Word[]>;
  /** Ready to render: analysis finished and produced tokens. */
  ready: boolean;
}

/** Nothing analyzed (yet, or at all) — a stable identity, so a caller that renders
 *  through a memoized reader doesn't re-render on every parent pass. */
const EMPTY_PART: SenseExamplePart = { tokens: [], meaningsByWord: new Map(), ready: false };

export interface SenseExampleReader {
  /** One entry per `texts` entry, SAME ORDER — callers index positionally. */
  parts: SenseExamplePart[];
  /** Dictionary sense ids the user has saved — drives the reader's colouring. */
  saved: Set<string>;
  /** wordId → 0-5 confidence, for the red→green shading of a known word. */
  confidence: Map<string, number>;
  lists: List[];
  loading: boolean;
  addWords: (words: Word[], listId?: string) => Promise<void>;
  createNamedList: (name: string) => Promise<string>;
}

export function useSenseExampleReader(params: {
  userId: string;
  /**
   * The row's curated prose, in order — today [example, definition]. A null entry (the
   * row has no such piece) still occupies its slot, so a caller's indices are fixed and
   * a missing example can't silently shift the definition into its place.
   */
  texts: ReadonlyArray<string | null>;
  /** Language of `texts` — the row's own source language, not a global default. */
  sourceLang: LangCode;
  /** Language to resolve meanings INTO (the row's target). */
  targetLang: LangCode;
  /** Only load once the panel is open. */
  active: boolean;
}): SenseExampleReader {
  const { userId, texts, sourceLang, targetLang, active } = params;
  const [parts, setParts] = useState<SenseExamplePart[]>([]);
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const [confidence, setConfidence] = useState<Map<string, number>>(new Map());
  const [lists, setLists] = useState<List[]>([]);
  const [loading, setLoading] = useState(false);
  // The prose already analysed, so re-opening a panel doesn't re-run kuromoji. Keyed on
  // ALL the pieces at once — they load together, so they are one cache entry.
  const loadedFor = useRef<string | null>(null);
  // `texts` is an array literal at the call site, so its identity changes every render
  // and it cannot be an effect dependency. The KEY below is the reactive value; the ref
  // is how the effect reads the matching strings without re-subscribing to them.
  const textsRef = useRef(texts);
  textsRef.current = texts;
  const key = texts.map((t) => t ?? "").join("\u0000");

  useEffect(() => {
    const pieces = textsRef.current;
    if (!active || pieces.every((t) => !t) || loadedFor.current === key) return;
    let cancelled = false;
    loadedFor.current = key;
    setLoading(true);

    (async () => {
      try {
        // In PARALLEL, and they must stay that way: the panel opens as a unit, so the
        // second piece waiting on the first would show the definition arriving visibly
        // late under an already-coloured sentence. kuromoji is a lazy singleton, so the
        // two share one load rather than racing for two.
        const paras = await Promise.all(
          pieces.map((t) =>
            t
              ? translateParagraph({
                  input: t,
                  sourceLang,
                  targetLang,
                  skipGloss: true, // the English is authored — never buy a translation for it
                  dictionaryOnly: true, // and never fall through to paid MT for an odd word
                })
              : null,
          ),
        );
        if (cancelled) return;
        setParts(
          paras.map((para) =>
            para && para.tokens.length > 0
              ? { tokens: para.tokens, meaningsByWord: para.meanings, ready: true }
              : EMPTY_PART,
          ),
        );

        // The user's own knowledge of the senses in the prose — this is what makes it
        // legible at a glance: which of these words do I already have? Resolved ACROSS
        // the pieces in one call, so a word in both is one lookup and one answer.
        const ids = [
          ...new Set(paras.flatMap((p) => (p ? [...p.meanings.values()].flat().map((w) => w.wordId) : []))),
        ];
        if (ids.length > 0) {
          const states = await getUserWordStates({ userId, dictionaryWordIds: ids });
          if (cancelled) return;
          const nextSaved = new Set<string>();
          const nextConfidence = new Map<string, number>();
          for (const [wordId, s] of states) {
            if (s.tracked) nextSaved.add(wordId);
            nextConfidence.set(wordId, s.confidenceRating);
          }
          setSaved(nextSaved);
          setConfidence(nextConfidence);
        }

        const userLists = await listUserLists(userId);
        if (!cancelled) setLists(userLists);
      } catch (e) {
        // A failed analysis is a missing enhancement, never a broken row: the plain
        // prose still renders (see SenseExample's fallback).
        console.warn("useSenseExampleReader: could not analyze the sense prose", e);
        if (!cancelled) loadedFor.current = null; // let a reopen retry
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [active, key, sourceLang, targetLang, userId]);

  const addWords = useCallback(
    async (words: Word[], listId?: string) => {
      await saveDictionaryWords({ userId, words, listId });
      // Reflect it immediately — the word turns from addable-blue to known without a
      // reload, which is the point of adding from inside the sentence.
      setSaved((prev) => {
        const next = new Set(prev);
        for (const w of words) next.add(w.wordId);
        return next;
      });
    },
    [userId],
  );

  const createNamedList = useCallback(
    async (name: string) => {
      const list = await createList({ userId, listName: name });
      setLists((prev) => [...prev, list]);
      return list.listId;
    },
    [userId],
  );

  return {
    // Padded to `texts`, so a caller can index a slot whose analysis hasn't landed (or
    // never will, because that piece is null) without a length check at every use.
    parts: texts.map((_, i) => parts[i] ?? EMPTY_PART),
    saved,
    confidence,
    lists,
    loading,
    addWords,
    createNamedList,
  };
}
