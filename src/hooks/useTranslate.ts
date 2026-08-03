// Unified translate flow. ONE input — kuromoji decides whether it's a single
// word or a phrase/sentence (no manual Word/Paragraph toggle):
//   · single word  → look up the dictionary form (so 行った resolves via 行く),
//                     show ALL senses, save the primary on demand.
//   · sentence     → the reader: each word colored by knowledge, hover for its
//                     meanings. Each sense is addable INDIVIDUALLY (homographs
//                     like 辛い → からい / つらい are separate senses, so you can
//                     add exactly the one you mean), and "Add all" saves the
//                     primary of every new word at once.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStickyState } from "./useStickyState";
import { pushEntry, type TranslateHistoryEntry } from "../services/translateHistory";
import { nfc, nfcTrim } from "../lib/text";
import { lookupWord, lookupWordsBatch, translateParagraph, type ParagraphTranslation } from "../services/lookup";
import { translate, glossSentences, getCachedGloss } from "../services/translation";
import { saveDictionaryWord, saveDictionaryWords, getUserWordStates } from "../services/words/userWords";
import { listUserLists, createList, type List } from "../services/lists";
import { getUserLimits, DEFAULT_LIMITS, type UserLimits } from "../services/entitlements";
import { recordReview } from "../services/review";
import { getUserLevel, seedStability } from "../services/calibration";
import { getDifficulty, type LevelValue } from "../services/difficulty";
import { contextByWord as contextForWords, type WordContext } from "../services/analyze/context";
import { orderSensesByContextReading } from "../services/analyze/senseOrder";
import {
  analyze,
  splitSentences,
  isSingleWord,
  isContentPos,
  dictionaryFormOf,
  resolveSourceLanguage,
  SUPPORTED_LANGUAGES,
  DEFAULT_LEARNING_LANGUAGE,
  DEFAULT_NATIVE_LANGUAGE,
  type LangCode,
  type SourceSelection,
} from "../services/language";
import { errorMessage as message } from "../lib/errorMessage";
import { useLanguagePrefs } from "./useLanguagePrefs";
import type { Word } from "../services/words/repository";

export type TranslateMode = "word" | "paragraph";
export type TranslateStatus = "idle" | "loading" | "done" | "error";

export function useTranslate(userId: string) {
  // SOURCE (input) defaults to the LEARNING language and TARGET (output) to the
  // NATIVE language: you type the language you're studying and read its meaning in
  // your own language (type Japanese → English gloss + word-by-word reader). The
  // profile effect below pins both to the user's saved prefs once loaded. Both stay
  // freely changeable in the LangBar (incl. switching source to Detect).
  const [source, setSource] = useState<SourceSelection>(DEFAULT_LEARNING_LANGUAGE);
  const [target, setTarget] = useState<LangCode>(DEFAULT_NATIVE_LANGUAGE);
  // Sticky: what you typed survives a tab switch. The RESULTS deliberately don't
  // (they'd be a stale mirror of saved/confidence state) — you come back to your
  // text with a clean slate and re-submit.
  const [input, setInput] = useStickyState(userId, "translate.input", "");
  // What you translated this session — same sticky cache as the input, so it
  // survives a tab switch and dies with the page. Recorded on SUCCESS only (see
  // the effect below), so a failed submit (quota 429, oversize 413, network)
  // doesn't leave an entry that replays straight back into the same error.
  const [history, setHistory] = useStickyState<TranslateHistoryEntry[]>(
    userId,
    "translate.history",
    [],
  );
  // Set at submit time, consumed when the status reaches "done". A ref, not state:
  // it must not re-render, and submit has several success exits — capturing once at
  // the top and committing on the status transition covers them all without
  // threading a record call through each `return`.
  const pendingEntry = useRef<TranslateHistoryEntry | null>(null);
  const [status, setStatus] = useState<TranslateStatus>("idle");
  const [mode, setMode] = useState<TranslateMode>("word");
  const [error, setError] = useState<string | null>(null);

  // The language the user is LEARNING. The study surface (reader / add / quiz)
  // always operates on THIS language's words — the input when the user types it,
  // else the OUTPUT (so typing English while learning JA studies the Japanese
  // translation's words, not the English input). Independent of the translate
  // direction; swapping languages doesn't change what you're learning.
  const [learning, setLearning] = useState<LangCode>(DEFAULT_LEARNING_LANGUAGE);
  // The plain translation shown in the output box (the other language's rendering
  // of what you typed). Set by submit; distinct from the study data.
  const [output, setOutput] = useState("");

  // word mode
  const [headword, setHeadword] = useState("");
  const [meanings, setMeanings] = useState<Word[]>([]);

  // paragraph mode
  const [para, setPara] = useState<ParagraphTranslation | null>(null);
  // True while the word-by-word reader (kuromoji analysis + per-word lookups) is
  // still loading AFTER the whole-sentence translation is already shown — lets the
  // UI display the translation immediately with a spinner below for the reader.
  const [readerLoading, setReaderLoading] = useState(false);
  const [analyzedInput, setAnalyzedInput] = useState("");
  // True while the ON-DEMAND sentence gloss is in flight (see loadGloss).
  const [glossLoading, setGlossLoading] = useState(false);

  // Per-SENSE state, keyed by dictionary wordId — shared by both modes so the
  // popover/results can add an exact sense (e.g. つらい without からい).
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState<Set<string>>(new Set());
  const [confidence, setConfidence] = useState<Map<string, number>>(new Map());
  const [userWordIds, setUserWordIds] = useState<Map<string, string>>(new Map());
  /** Senses whose knowledge state has already been fetched — see syncSenseState. */
  const syncedIds = useRef<Set<string>>(new Set());

  // Destination for adds: a sub-list (also tags it) or null = just ALL. The
  // The user's sub-lists (the add buttons' second-click menu offers these + "new").
  const [lists, setLists] = useState<List[]>([]);
  useEffect(() => {
    listUserLists(userId).then(setLists).catch((e) => console.warn("useTranslate: failed to load sub-lists", e));
  }, [userId]);

  // The user's effective restrictions (e.g. paragraph char limit). Defaults
  // until loaded so the first submit still has a sane cap. The edge function
  // re-enforces server-side — this copy is for instant UX feedback.
  const [limits, setLimits] = useState<UserLimits>(DEFAULT_LIMITS);
  useEffect(() => {
    getUserLimits(userId).then(setLimits).catch((e) => console.warn("useTranslate: failed to load limits (using defaults)", e));
  }, [userId]);

  // The user's calibrated level (#10), used to seed cold-start stability when
  // adding un-quizzed words so a known vocabulary doesn't all start at 0. null
  // until calibrated → seedStability returns null → today's cold-start behavior.
  const [level, setLevel] = useState<LevelValue | null>(null);
  useEffect(() => {
    getUserLevel(userId).then(setLevel).catch((e) => console.warn("useTranslate: failed to load level (no cold-start seeding)", e));
  }, [userId]);

  // Default the directions from the user's profile prefs (Profile page). SOURCE
  // (input) = the LEARNING language, TARGET (output) = the NATIVE language, so the
  // user types what they study and reads the meaning in their own language. Falls
  // back to the registry defaults for a fresh guest (no saved prefs). Both stay
  // changeable in the LangBar.
  const prefs = useLanguagePrefs(userId);
  useEffect(() => {
    setSource(prefs.learning);
    setTarget(prefs.native);
    setLearning(prefs.learning);
  }, [prefs]);

  // The explanation language the reader's words were studied in (set by submit);
  // domain expansion looks related words up in the same learning→native direction.
  const [nativeLang, setNativeLang] = useState<LangCode>("EN");

  /** Create a sub-list and return its id (the add buttons then tag into it). */
  const createNamedList = useCallback(
    async (name: string): Promise<string> => {
      const list = await createList({ userId, listName: name.trim() });
      setLists((ls) => [...ls, list]);
      return list.listId;
    },
    [userId]
  );

  // Submit is a BUTTON, never Enter (IME confirms kanji with Enter). Accepts
  // optional overrides so swap() can translate the swapped text/langs immediately
  // without waiting for the setState round-trip (state is still updated for the UI).
  const submit = useCallback(async (override?: {
    text?: string;
    source?: SourceSelection;
    target?: LangCode;
    /** Skip the whole-paragraph MT gloss (media summary page — reader only). */
    skipGloss?: boolean;
  }) => {
    const text = (override?.text ?? input).trim();
    if (!text || status === "loading" || readerLoading) return;
    const src = override?.source ?? source;
    const tgt = override?.target ?? target;
    pendingEntry.current = { text, source: src, target: tgt };
    setStatus("loading");
    setReaderLoading(false);
    setError(null);
    try {
      const resolvedSource = resolveSourceLanguage(text, src);

      // Input language == output language → nothing to TRANSLATE: echo the input,
      // make no API calls and render no reader. (You study by typing the LEARNING
      // language while the output sits on your native/explanation language, so the
      // input and output sides differ; when they're the same there's nothing to do.)
      if (resolvedSource === tgt) {
        setOutput(text);
        setMeanings([]);
        setPara(null);
        setAnalyzedInput("");
        setHeadword(text);
        setMode("word");
        setStatus("done");
        return;
      }

      // The STUDY orients on the LEARNING language; `native` is the OTHER side
      // (the explanation language). If the user typed the learning language we
      // study the input directly; otherwise we translate the input INTO the
      // learning language and study THAT (so typing English while learning JA
      // studies the Japanese translation, not the English input).
      const typedLearning = resolvedSource === learning;
      // `native` (the explanation language) must NOT be the learning language. When
      // the user typed the learning language, it's the target — unless that's also
      // the learning language (e.g. target left on JA), in which case fall back to
      // the other supported language so we never do a learning→learning lookup.
      const native: LangCode = !typedLearning
        ? resolvedSource
        : tgt !== learning
          ? tgt
          : SUPPORTED_LANGUAGES.find((l) => l.code !== learning)?.code ?? tgt;
      setNativeLang(native);

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
        // This is the AUTHORITATIVE state for the new result and REPLACES what came
        // before, so the live reader's incremental record starts over with it —
        // otherwise a sense it had already fetched would be skipped for ever, even
        // though this reset just dropped it.
        syncedIds.current = new Set(ids);
      };

      // CASE B, single typed word → surface the learning language's DISTINCT
      // equivalents (bat → バット AND 蝙蝠), each studied as a learning-language word.
      // (Translating to one string would collapse to just the top equivalent.)
      if (!typedLearning) {
        const inputTokens = await analyze(text, resolvedSource);
        if (isSingleWord(inputTokens, resolvedSource)) {
          const enja = await lookupWord({ input: text, sourceLang: resolvedSource, targetLang: learning });
          // Distinct candidate writings in the EN→JA rank order (relevance, then
          // core-match, then frequency — see jmdict_lookup), capped. The ranking
          // already surfaces the common, relevant equivalents (word → 言葉, bat →
          // バット) ahead of rare/tangential ones, so we keep that order as-is.
          const candidates: string[] = [];
          const seenC = new Set<string>();
          for (const m of enja.meanings) {
            const jp = nfcTrim(m.translation);
            if (jp && !seenC.has(jp)) { seenC.add(jp); candidates.push(jp); }
            if (candidates.length >= 8) break;
          }
          if (candidates.length === 0) {
            setOutput(""); setMeanings([]); setPara(null); setAnalyzedInput("");
            setHeadword(text); setMode("word"); setStatus("done");
            return;
          }
          // Study each candidate learning→native; the TOP keeps all its senses, the
          // rest contribute their primary. Deduped by wordId. ONE batched lookup
          // for all candidates (1 DB read + 1 edge call) instead of N per-word calls.
          const byCandidate = await lookupWordsBatch({
            inputs: candidates,
            sourceLang: learning,
            targetLang: native,
          });
          const studied = candidates.map((jp) => byCandidate.get(jp) ?? []);
          const meanings: Word[] = [];
          const seenW = new Set<string>();
          studied.forEach((senses, i) => {
            for (const m of i === 0 ? senses : senses.slice(0, 1)) {
              if (!seenW.has(m.wordId)) { seenW.add(m.wordId); meanings.push(m); }
            }
          });
          await loadSenseState(meanings.map((m) => m.wordId));
          setHeadword(meanings[0]?.input ?? candidates[0]);
          setMeanings(meanings);
          setPara(null);
          setAnalyzedInput("");
          setOutput(meanings[0]?.input ?? candidates[0]);
          setMode("word");
          setStatus("done");
          return;
        }
      }

      // Otherwise study the learning-language TEXT: the input when you typed the
      // learning language, else its whole translation (a sentence).
      let learningText: string;
      let outputText: string; // the plain text shown in the output box
      if (typedLearning) {
        learningText = text;
        outputText = ""; // filled from the learning→native study below (the gloss)
      } else {
        const disp = await translate({
          input: text,
          sourceLang: resolvedSource,
          targetLang: learning,
          persist: false,
        });
        if (!disp.translated || !disp.translation) {
          setOutput("");
          setMeanings([]);
          setPara(null);
          setMode("word");
          setStatus("done");
          return;
        }
        learningText = nfcTrim(disp.translation);
        outputText = learningText;
      }

      // Analyze + study the LEARNING text in the learning → native direction.
      const tokens = await analyze(learningText, learning);

      if (isSingleWord(tokens, learning)) {
        // Resolve the dictionary form from the CONTENT token (行った → 行く).
        const lemma = dictionaryFormOf(tokens, learningText);
        const r = await lookupWord({ input: lemma, sourceLang: learning, targetLang: native });
        await loadSenseState(r.meanings.map((m) => m.wordId));
        setHeadword(r.input);
        setMeanings(r.meanings);
        setPara(null);
        setAnalyzedInput("");
        outputText = r.meanings[0]?.translation ?? "";
        setOutput(outputText);
        setMode("word");
        setStatus("done");
        return;
      }

      // Sentence → reader. Enforce the per-user paragraph char limit (free-tier
      // guard) up front; the edge function re-checks as the hard gate. This guards
      // the PAID whole-paragraph gloss — so skip it when skipGloss is set (the media
      // summary makes no gloss call, so a long article is free to analyze in full).
      if (!override?.skipGloss && learningText.length > limits.paragraphCharLimit) {
        setError(
          `This text is ${learningText.length} characters; the limit is ${limits.paragraphCharLimit}. Please shorten it.`
        );
        setStatus("error");
        return;
      }
      setAnalyzedInput(nfc(learningText));
      setMode("paragraph");
      setPara(null);
      setMeanings([]);

      // Show the whole-sentence TRANSLATION as soon as it's known, then stream the
      // word-by-word reader in below (kuromoji's first load + lookups are the slow
      // part). For !typedLearning the output IS the learning translation (already
      // known); for typedLearning it's the gloss, revealed via onGloss the moment it
      // lands. Either way status flips to "done" (output visible) with readerLoading
      // true (spinner under the reader) until the tokens/meanings arrive.
      const revealReader = () => { setReaderLoading(true); setStatus("done"); };
      if (!typedLearning) { setOutput(outputText); revealReader(); }

      const p = await translateParagraph({
        input: learningText,
        sourceLang: learning,
        targetLang: native,
        tokens, // reuse submit's analysis — skip a duplicate kuromoji tokenize
        skipGloss: override?.skipGloss,
        onGloss: typedLearning
          ? (g) => { setOutput(g.translated ? g.translation : ""); revealReader(); }
          : undefined,
      });
      const ids: string[] = [];
      p.meanings.forEach((senses) => senses.forEach((s) => ids.push(s.wordId)));
      await loadSenseState(ids);
      setPara(p);
      setReaderLoading(false);
      setStatus("done");
    } catch (e) {
      setError(message(e));
      setStatus("error");
      setReaderLoading(false);
    }
  }, [input, source, target, status, readerLoading, userId, limits, learning]);

  /**
   * Fetch the sentence-by-sentence translation for the paragraph ALREADY analyzed,
   * and fold it into `para.sentences`.
   *
   * This exists so the reader's "Show translation" toggle can PAY ON DEMAND. A
   * media article is analyzed with `skipGloss` (opening one must cost nothing —
   * the summary never shows a translation), which used to mean an article could
   * never show one at all. Now the first press of the toggle buys it, and only
   * for a reader who actually asked; a reader who never toggles never spends.
   *
   * Idempotent + single-flight: a paragraph already glossed, or a request in
   * flight, is a no-op — so double-clicking the toggle can't buy it twice.
   * A failure is non-fatal: the reader keeps rendering, just without English.
   */
  // Commit the pending entry once a submit actually succeeds. Keyed on the status
  // transition rather than called inside submit because submit has several success
  // exits (echo, EN→JA candidates, word, reader) and only ONE failure path — this
  // records all of the former and none of the latter. Clearing the ref makes it
  // idempotent, so an unrelated re-render at status "done" can't double-add.
  useEffect(() => {
    if (status !== "done") return;
    const entry = pendingEntry.current;
    if (!entry) return;
    pendingEntry.current = null;
    setHistory((prev) => pushEntry(prev, entry));
  }, [status, setHistory]);

  /**
   * Re-run a history entry: restore the text AND the direction it was translated
   * in, then submit. Both the LangBar and the request are set from the entry so
   * what the user sees matches what actually ran — replaying with an override
   * while the bar still showed the current direction would silently disagree.
   */
  const replayHistory = useCallback(
    (entry: TranslateHistoryEntry) => {
      setInput(entry.text);
      setSource(entry.source);
      setTarget(entry.target);
      void submit({ text: entry.text, source: entry.source, target: entry.target });
    },
    [setInput, submit],
  );

  const clearHistory = useCallback(() => setHistory([]), [setHistory]);

  const loadGloss = useCallback(async () => {
    if (glossLoading) return;
    const text = analyzedInput;
    if (!text || !para || para.sentences.some((s) => s.gloss)) return;
    // The gloss is the PAID path, so the per-user char limit applies here as it
    // does in submit (the edge re-checks as the hard gate).
    if (text.length > limits.paragraphCharLimit) {
      setError(
        `This text is ${text.length} characters; the limit is ${limits.paragraphCharLimit}.`
      );
      return;
    }
    setGlossLoading(true);
    try {
      const spans = splitSentences(text);
      // Through the CACHE: sentences already bought one at a time (by tapping their
      // punctuation) are free here, so pressing the toggle after tapping a few costs
      // only what is left. Never the reverse.
      const glosses = await glossSentences({
        segments: spans.map((s) => s.text),
        sourceLang: learning,
        targetLang: nativeLang, // resolved by submit — the explanation language
      });
      const sentences = spans.map((s, i) => ({ ...s, gloss: glosses[i] ?? null }));
      // Guard against a late response landing on a DIFFERENT paragraph (the user
      // navigated on): only apply while the analyzed text is still the same.
      setPara((prev) => (prev && prev.tokens === para.tokens ? { ...prev, sentences } : prev));
    } catch (e) {
      setError(message(e));
    } finally {
      setGlossLoading(false);
    }
  }, [analyzedInput, para, glossLoading, limits, learning, nativeLang]);

  /**
   * Buy the English for ONE sentence — the reader's punctuation affordance. Folds
   * it into `para.sentences` so it shows under that line alone.
   *
   * The cheap half of loadGloss: one sentence, and free if it was already bought
   * (here or by a whole-paragraph press). Idempotent — a sentence that already has
   * a gloss is a no-op, so a second tap costs nothing.
   */
  const loadSentenceGloss = useCallback(
    async (index: number) => {
      const text = analyzedInput;
      if (!text || !para) return;
      const spans = splitSentences(text);
      const span = spans[index];
      if (!span || para.sentences[index]?.gloss) return;
      try {
        const [gloss] = await glossSentences({
          segments: [span.text],
          sourceLang: learning,
          targetLang: nativeLang,
        });
        if (!gloss) return;
        setPara((prev) => {
          if (!prev || prev.tokens !== para.tokens) return prev; // moved on
          // Seed every sentence from the cache while we're here: earlier taps and
          // this one all show at once, without another request.
          const sentences = spans.map((s, i) => ({
            ...s,
            gloss:
              prev.sentences[i]?.gloss ??
              getCachedGloss(s.text, learning, nativeLang) ??
              null,
          }));
          return { ...prev, sentences };
        });
      } catch (e) {
        setError(message(e));
      }
    },
    [analyzedInput, para, learning, nativeLang],
  );

  /**
   * Fill in the knowledge state (saved / confidence) for senses the LIVE reader has
   * found, so it can colour them without a submit.
   *
   * Colours are read from `saved`/`confidence`, which only submit used to populate —
   * so while typing or dictating, a word already known at 5/5 rendered blue
   * "addable", which is worse than no colour: it says you don't have a word you do.
   *
   * MERGES, never replaces. submit's loadSenseState owns the authoritative reset for
   * a whole result; this only adds what it learned about a few more senses, so it
   * can't wipe that — or race an in-flight save's optimistic mark.
   *
   * Free: one `user_words` read, no dictionary and no MT. Each sense is fetched ONCE
   * (the live reader re-analyzes on every pause, and re-asking the same question on
   * every keystroke is how a free path stops being free). Saves and reviews update
   * the state directly, so a fetched sense never needs asking again.
   */
  const syncSenseState = useCallback(
    async (dictionaryWordIds: string[]) => {
      const ids = dictionaryWordIds.filter((id) => !syncedIds.current.has(id));
      if (ids.length === 0) return;
      ids.forEach((id) => syncedIds.current.add(id));
      try {
        const tracked = await getUserWordStates({ userId, dictionaryWordIds: ids });
        const owned = [...tracked].filter(([, st]) => st.tracked);
        if (owned.length === 0) return;
        setSaved((prev) => {
          const next = new Set(prev);
          owned.forEach(([id]) => next.add(id));
          return next;
        });
        setConfidence((prev) => {
          const next = new Map(prev);
          owned.forEach(([id, st]) => next.set(id, st.confidenceRating));
          return next;
        });
        setUserWordIds((prev) => {
          const next = new Map(prev);
          owned.forEach(([id, st]) => { if (st.userWordId) next.set(id, st.userWordId); });
          return next;
        });
      } catch (e) {
        // Non-fatal: the reader still works, it just isn't coloured yet. Re-allow the
        // ask, so a transient failure isn't cached as "already fetched".
        ids.forEach((id) => syncedIds.current.delete(id));
        console.warn("useTranslate: failed to sync sense state for the live reader", e);
      }
    },
    [userId],
  );

  /** Swap source↔target, move the OUTPUT text into the input, and re-translate —
   *  the Google-Translate swap. Just swaps languages when there's nothing to move. */
  const swap = useCallback(() => {
    if (status === "loading") return;
    const newSource: SourceSelection = target; // old target (concrete) → new source
    const newTarget: LangCode = resolveSourceLanguage(input, source); // old source, resolved
    const text = output; // the translation becomes the new input
    setSource(newSource);
    setTarget(newTarget);
    setInput(text);
    if (text.trim()) void submit({ text, source: newSource, target: newTarget });
  }, [status, target, source, input, output, submit, setInput]);

  /** Mark a sense saved at the given confidence (shared by the save paths). */
  const markSaved = useCallback((wordId: string, userWordId: string, confidenceRating: number) => {
    setSaved((s) => new Set(s).add(wordId));
    setConfidence((m) => new Map(m).set(wordId, confidenceRating));
    setUserWordIds((m) => new Map(m).set(wordId, userWordId));
  }, []);

  /** Save one exact dictionary sense into the vocabulary (to ALL). Used by the
   *  reader's per-word add; the +/menu button uses addWords below. */
  const addSense = useCallback(
    async (word: Word) => {
      if (saved.has(word.wordId) || saving.has(word.wordId)) return;
      setSaving((s) => new Set(s).add(word.wordId));
      setError(null);
      try {
        const uw = await saveDictionaryWord({
          userId,
          word,
          initialStability: seedStability(getDifficulty(word).level, level),
        });
        markSaved(word.wordId, uw.userWordId, uw.confidenceRating);
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
    [userId, saved, saving, markSaved, level]
  );

  /** Add/tag a set of senses to ALL (no listId) or into a sub-list. Idempotent,
   *  so it both creates the entry (first call) and adds the tag (second call).
   *  Backs the AddToListButton (single word + "Add all"). Throws on failure so
   *  the button can stay in its menu/idle state. */
  const addWords = useCallback(
    async (words: Word[], listId?: string) => {
      setError(null);
      // One batched RPC instead of N saves (all-or-nothing in a single
      // transaction); then mark each saved sense from the returned rows.
      const saved = await saveDictionaryWords({
        userId,
        words,
        listId,
        seedFor: (w) => seedStability(getDifficulty(w).level, level),
      });
      const byId = new Map(saved.map((uw) => [uw.dictionaryWordId, uw]));
      for (const word of words) {
        const uw = byId.get(word.wordId);
        if (uw) markSaved(word.wordId, uw.userWordId, uw.confidenceRating);
      }
    },
    [userId, markSaved, level]
  );

  /** #12 — expand the paragraph into RELATED domain words at the user's level:
   *  pool the word map over the content words, then resolve the top candidates to
   *  quizzable Words (dropping ones already in the vocabulary). The caller opens a
   *  quiz over the result. Returns [] when there's nothing (un-embedded seeds, or
   *  all already known). */

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

  // Distinct CONTENT words' PRIMARY senses, partitioned in ONE pass by whether
  // they're saved: addable (not yet saved — "Add all" + text-quiz targets) vs
  // reviewable (already saved — re-quiz a studied paragraph via SRS).
  // Particles/auxiliaries are excluded via POS.
  // addableCards carries ALL senses of each NEW word (primary first) so the quiz
  // can cycle meanings + add a chosen one; addablePrimaries is the primary-only
  // view kept for the count and the "Add all" path.
  const { addablePrimaries, reviewablePrimaries, addableCards } = useMemo(() => {
    const addable: Word[] = [];
    const reviewable: Word[] = [];
    const cards: Word[][] = [];
    if (para) {
      const seen = new Set<string>();
      for (const tok of para.tokens) {
        if (!isContentPos(tok.pos) || seen.has(tok.text)) continue;
        seen.add(tok.text);
        // Lead with the sense the SENTENCE used: kuromoji read this surface in
        // context, so a homograph (辛い → からい / つらい) shows the meaning that's
        // actually on the page instead of whichever the dictionary ranked first.
        // No-op unless the reading genuinely separates the senses.
        const senses = orderSensesByContextReading(para.meanings.get(tok.text) ?? [], tok.reading);
        const primary = senses[0];
        if (!primary) continue;
        if (saved.has(primary.wordId)) reviewable.push(primary);
        else { addable.push(primary); cards.push(senses); }
      }
    }
    return { addablePrimaries: addable, reviewablePrimaries: reviewable, addableCards: cards };
  }, [para, saved]);

  // "Show in context" (the quiz's reveal panel): word → the source sentences it
  // appeared in. Split HERE rather than reading `para.sentences`, because the split
  // is pure and free while only the GLOSS costs money — so an analysis run with
  // skipGloss (the Media article path) has `para.sentences` empty yet still deserves
  // context. Any glosses already loaded are folded back in by sentence offset.
  const contextByWord = useMemo(() => {
    if (!para || !analyzedInput) return new Map<string, WordContext[]>();
    const glossAt = new Map(para.sentences.map((s) => [s.start, s.gloss]));
    return contextForWords({
      tokens: para.tokens,
      meaningsByWord: para.meanings,
      sentences: splitSentences(analyzedInput).map((s) => ({
        ...s,
        gloss: glossAt.get(s.start) ?? null,
      })),
    });
  }, [para, analyzedInput]);

  return {
    source, setSource, target, setTarget, input, setInput,
    status, mode, error,
    // the language being learned (study/add/quiz target)
    learning, setLearning,
    // Google-Translate-style output box + swap (langs + text + re-translate)
    output, swap,
    // shared per-sense state
    saved, saving, confidence, addSense, markUnknown, syncSenseState,
    // word mode
    headword, meanings,
    // paragraph mode
    para, analyzedInput, readerLoading,
    // on-demand sentence gloss for the reader's "Show translation" toggle
    loadGloss, glossLoading, loadSentenceGloss,
    // extract-and-quiz (#9): new content words (learn) + saved ones (review) +
    // the state-sync callback the quiz uses after each grade.
    addablePrimaries, reviewablePrimaries, addableCards,
    // word → the sentences it appeared in, for the quiz's "Show in context" panel.
    contextByWord,
    addableCount: addablePrimaries.length,
    reviewableCount: reviewablePrimaries.length, applyReview,
    // add buttons: tag to ALL / a sub-list (idempotent) + create-and-tag.
    lists, addWords, createNamedList,
    // session-only record of what you translated (dies with the page)
    history, replayHistory, clearHistory,
    submit,
  };
}
