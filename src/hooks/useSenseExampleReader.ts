// =========================================================
// Turn a curated example sentence into something the READER can render.
//
// The corpus stores an example as plain text. The whole design intent is that it renders
// through ParagraphReader — every word in it furigana'd, coloured by what the user
// already knows, and addable — so the sentence under a word is itself a way in to more
// words ("the rabbit hole is the FEATURE", docs/TODO.md). That needs three things the
// stored string doesn't carry: kuromoji tokens, a meaning list per word, and the user's
// own saved/confidence state for those senses.
//
// LAZY BY CONSTRUCTION. Nothing runs until a row's panel is actually opened (`active`),
// because a Lists page renders dozens of rows and analysing every example on mount would
// load kuromoji and fan out lookups for sentences nobody asked to see. Once loaded it
// stays loaded — reopening the same row is instant.
//
// COSTS NOTHING. `skipGloss` (the English is already authored, so there is no paragraph
// to translate) plus `dictionaryOnly` (a word JMdict lacks comes back with no meanings
// rather than falling through to paid MT). Opening an example must never bill Google —
// it is a reference surface, not a translation request.
// =========================================================
import { useCallback, useEffect, useRef, useState } from "react";
import { translateParagraph } from "../services/lookup";
import { getUserWordStates, saveDictionaryWords } from "../services/words/userWords";
import { listUserLists, createList, type List } from "../services/lists";
import type { AnalyzedToken, LangCode } from "../services/language";
import type { Word } from "../services/words/repository";

export interface SenseExampleReader {
  tokens: AnalyzedToken[];
  meaningsByWord: Map<string, Word[]>;
  /** Dictionary sense ids the user has saved — drives the reader's colouring. */
  saved: Set<string>;
  /** wordId → 0-5 confidence, for the red→green shading of a known word. */
  confidence: Map<string, number>;
  lists: List[];
  loading: boolean;
  /** Ready to render: analysis finished and produced tokens. */
  ready: boolean;
  addWords: (words: Word[], listId?: string) => Promise<void>;
  createNamedList: (name: string) => Promise<string>;
}

export function useSenseExampleReader(params: {
  userId: string;
  /** The curated sentence, or null when the row has none. */
  text: string | null;
  /** Language of `text` — the row's own source language, not a global default. */
  sourceLang: LangCode;
  /** Language to resolve meanings INTO (the row's target). */
  targetLang: LangCode;
  /** Only load once the panel is open. */
  active: boolean;
}): SenseExampleReader {
  const { userId, text, sourceLang, targetLang, active } = params;
  const [tokens, setTokens] = useState<AnalyzedToken[]>([]);
  const [meaningsByWord, setMeanings] = useState<Map<string, Word[]>>(new Map());
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const [confidence, setConfidence] = useState<Map<string, number>>(new Map());
  const [lists, setLists] = useState<List[]>([]);
  const [loading, setLoading] = useState(false);
  // The sentence already analysed, so re-opening a panel doesn't re-run kuromoji.
  const loadedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!active || !text || loadedFor.current === text) return;
    let cancelled = false;
    loadedFor.current = text;
    setLoading(true);

    (async () => {
      try {
        const para = await translateParagraph({
          input: text,
          sourceLang,
          targetLang,
          skipGloss: true, // the English is authored — never buy a translation for it
          dictionaryOnly: true, // and never fall through to paid MT for an odd word
        });
        if (cancelled) return;
        setTokens(para.tokens);
        setMeanings(para.meanings);

        // The user's own knowledge of the senses IN the sentence — this is what makes
        // the example legible at a glance: which of these words do I already have?
        const ids = [...para.meanings.values()].flat().map((w) => w.wordId);
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
        // A failed example is a missing enhancement, never a broken row: the plain
        // sentence still renders (see SenseExample's fallback).
        console.warn("useSenseExampleReader: could not analyze the example", e);
        if (!cancelled) loadedFor.current = null; // let a reopen retry
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [active, text, sourceLang, targetLang, userId]);

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
    tokens,
    meaningsByWord,
    saved,
    confidence,
    lists,
    loading,
    ready: tokens.length > 0,
    addWords,
    createNamedList,
  };
}
