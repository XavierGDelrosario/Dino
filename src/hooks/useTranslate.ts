// Unified translate flow. ONE input — kuromoji decides whether it's a single
// word or a phrase/sentence (no manual Word/Paragraph toggle):
//   · single word  → look up the dictionary form (so 行った resolves via 行く),
//                     show ALL senses, save the primary on demand.
//   · sentence     → the reader: each word colored by knowledge, hover for its
//                     meanings. Each sense is addable INDIVIDUALLY (homographs
//                     like 辛い → からい / つらい are separate senses, so you can
//                     add exactly the one you mean), and "Add all" saves the
//                     primary of every new word at once.
import { useCallback, useEffect, useMemo, useState } from "react";
import { lookupWord, translateParagraph, type ParagraphTranslation } from "../services/lookup";
import { saveDictionaryWord, getUserWordStates } from "../services/words/userWords";
import { listUserLists, createList, type List } from "../services/lists";
import { getUserLimits, DEFAULT_LIMITS, type UserLimits } from "../services/entitlements";
import { recordReview } from "../services/review";
import {
  analyze,
  isSingleWord,
  isContentPos,
  resolveSourceLanguage,
  AUTO_DETECT,
  type LangCode,
  type SourceSelection,
} from "../services/language";
import type { Word } from "../services/words/repository";

export type TranslateMode = "word" | "paragraph";
export type TranslateStatus = "idle" | "loading" | "done" | "error";

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function useTranslate(userId: string) {
  const [source, setSource] = useState<SourceSelection>(AUTO_DETECT);
  const [target, setTarget] = useState<LangCode>("EN");
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<TranslateStatus>("idle");
  const [mode, setMode] = useState<TranslateMode>("word");
  const [error, setError] = useState<string | null>(null);

  // word mode
  const [headword, setHeadword] = useState("");
  const [meanings, setMeanings] = useState<Word[]>([]);

  // paragraph mode
  const [para, setPara] = useState<ParagraphTranslation | null>(null);
  const [analyzedInput, setAnalyzedInput] = useState("");

  // Per-SENSE state, keyed by dictionary wordId — shared by both modes so the
  // popover/results can add an exact sense (e.g. つらい without からい).
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState<Set<string>>(new Set());
  const [confidence, setConfidence] = useState<Map<string, number>>(new Map());
  const [userWordIds, setUserWordIds] = useState<Map<string, string>>(new Map());

  // Destination for adds: a sub-list (also tags it) or null = just ALL. The
  // user picks it once and every add button honors it (word adds + "Add all").
  const [lists, setLists] = useState<List[]>([]);
  const [destListId, setDestListId] = useState<string | null>(null);
  useEffect(() => {
    listUserLists(userId).then(setLists).catch(() => {});
  }, [userId]);

  // The user's effective restrictions (e.g. paragraph char limit). Defaults
  // until loaded so the first submit still has a sane cap. The edge function
  // re-enforces server-side — this copy is for instant UX feedback.
  const [limits, setLimits] = useState<UserLimits>(DEFAULT_LIMITS);
  useEffect(() => {
    getUserLimits(userId).then(setLimits).catch(() => {});
  }, [userId]);

  /** Create a sub-list and make it the add destination. */
  const createDestList = useCallback(
    async (name: string) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      try {
        const list = await createList({ userId, listName: trimmed });
        setLists((ls) => [...ls, list]);
        setDestListId(list.listId);
      } catch (e) {
        setError(message(e));
      }
    },
    [userId]
  );

  // Submit is a BUTTON, never Enter (IME confirms kanji with Enter).
  const submit = useCallback(async () => {
    const text = input.trim();
    if (!text || status === "loading") return;
    setStatus("loading");
    setError(null);
    try {
      const resolvedSource = resolveSourceLanguage(text, source);
      const tokens = await analyze(text, resolvedSource);

      // Collect knowledge state for a set of senses (which are saved, at what
      // confidence) so the UI can mark them up front.
      const loadSenseState = async (ids: string[]) => {
        const tracked = ids.length
          ? await getUserWordStates({ userId, dictionaryWordIds: ids })
          : new Map();
        const s = new Set<string>();
        const conf = new Map<string, number>();
        const uw = new Map<string, string>();
        tracked.forEach((st, id) => {
          if (st.tracked) {
            s.add(id);
            conf.set(id, st.confidenceRating);
            if (st.userWordId) uw.set(id, st.userWordId);
          }
        });
        setSaved(s);
        setSaving(new Set());
        setConfidence(conf);
        setUserWordIds(uw);
      };

      if (isSingleWord(tokens, resolvedSource)) {
        // Look up the DICTIONARY FORM so inflected input (行った → 行く) resolves.
        const lemma = tokens.find((t) => t.lemma)?.lemma ?? text;
        const r = await lookupWord({ input: lemma, targetLang: target, sourceLang: source });
        await loadSenseState(r.meanings.map((m) => m.wordId));
        setHeadword(r.input);
        setMeanings(r.meanings);
        setMode("word");
        setStatus("done");
        return;
      }

      // Sentence → reader. Enforce the per-user paragraph char limit (free-tier
      // guard) up front; the edge function re-checks as the hard gate.
      if (text.length > limits.paragraphCharLimit) {
        setError(
          `This paragraph is ${text.length} characters; the limit is ${limits.paragraphCharLimit}. Please shorten it.`
        );
        setStatus("error");
        return;
      }
      setAnalyzedInput(text.normalize("NFC"));
      const p = await translateParagraph({ input: text, targetLang: target, sourceLang: source });
      const ids: string[] = [];
      p.meanings.forEach((senses) => senses.forEach((s) => ids.push(s.wordId)));
      await loadSenseState(ids);
      setPara(p);
      setMode("paragraph");
      setStatus("done");
    } catch (e) {
      setError(message(e));
      setStatus("error");
    }
  }, [input, source, target, status, userId, limits]);

  /** Save one exact dictionary sense into the vocabulary (and tag the chosen
   *  destination list, if any). */
  const addSense = useCallback(
    async (word: Word) => {
      if (saved.has(word.wordId) || saving.has(word.wordId)) return;
      setSaving((s) => new Set(s).add(word.wordId));
      setError(null);
      try {
        const uw = await saveDictionaryWord({
          userId,
          word,
          listId: destListId ?? undefined,
        });
        setSaved((s) => new Set(s).add(word.wordId));
        setConfidence((m) => new Map(m).set(word.wordId, uw.confidenceRating));
        setUserWordIds((m) => new Map(m).set(word.wordId, uw.userWordId));
      } catch (e) {
        setError(message(e));
      } finally {
        setSaving((s) => {
          const n = new Set(s);
          n.delete(word.wordId);
          return n;
        });
      }
    },
    [userId, saved, saving, destListId]
  );

  /** "Don't know" for an already-saved sense: a review lapse (lowers confidence). */
  const markUnknown = useCallback(
    async (word: Word) => {
      const uwid = userWordIds.get(word.wordId);
      if (!uwid || saving.has(word.wordId)) return;
      setSaving((s) => new Set(s).add(word.wordId));
      setError(null);
      try {
        const res = await recordReview({ userWordId: uwid, grade: 1 });
        setConfidence((m) => new Map(m).set(word.wordId, res.confidenceRating));
      } catch (e) {
        setError(message(e));
      } finally {
        setSaving((s) => {
          const n = new Set(s);
          n.delete(word.wordId);
          return n;
        });
      }
    },
    [userWordIds, saving]
  );

  /** Sync the reader's state after the text-quiz saves + reviews a word, so it
   *  stops showing as "new" without re-translating. Mirrors addSense's updates. */
  const applyReview = useCallback(
    (wordId: string, userWordId: string, confidenceRating: number) => {
      setSaved((s) => new Set(s).add(wordId));
      setConfidence((m) => new Map(m).set(wordId, confidenceRating));
      setUserWordIds((m) => new Map(m).set(wordId, userWordId));
    },
    [],
  );

  // Distinct CONTENT words whose PRIMARY sense isn't saved yet (the "Add all"
  // targets, and the text-quiz set). Particles/auxiliaries are excluded via POS.
  const addablePrimaries: Word[] = useMemo(() => {
    const result: Word[] = [];
    if (para) {
      const seen = new Set<string>();
      for (const tok of para.tokens) {
        if (!isContentPos(tok.pos) || seen.has(tok.text)) continue;
        seen.add(tok.text);
        const primary = para.meanings.get(tok.text)?.[0];
        if (primary && !saved.has(primary.wordId)) result.push(primary);
      }
    }
    return result;
  }, [para, saved]);

  /** Save the BEST (primary) sense of every not-yet-added word at once. */
  const addAll = useCallback(async () => {
    await Promise.all(addablePrimaries.map((w) => addSense(w)));
  }, [addablePrimaries, addSense]);

  return {
    source, setSource, target, setTarget, input, setInput,
    status, mode, error,
    // shared per-sense state
    saved, saving, confidence, addSense, markUnknown,
    // word mode
    headword, meanings,
    // paragraph mode
    para, analyzedInput,
    addableCount: addablePrimaries.length, addAll,
    // extract-and-quiz (#9): the new content words + a state-sync callback
    addablePrimaries, applyReview,
    // add destination (a sub-list, or null = ALL)
    lists, destListId, setDestListId, createDestList,
    submit,
  };
}
