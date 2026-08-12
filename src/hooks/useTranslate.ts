// Unified translate flow. ONE input — kuromoji decides word vs sentence, no manual
// toggle. A single word looks up its dictionary form (行った via 行く) and shows ALL
// senses; a sentence opens the reader, where each word is colored by knowledge and
// each sense is addable INDIVIDUALLY (so a homograph like 辛い lets you add exactly
// the meaning you want), plus "Add all" for every new word's primary.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStickyState } from "./useStickyState";
import { pushEntry, type TranslateHistoryEntry } from "../services/translateHistory";
import { nfc, nfcTrim } from "../lib/text";
import { lookupWord, lookupWordsBatch, translateParagraph, wordKey, type ParagraphTranslation } from "../services/lookup";
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
  detectLanguage,
  searchTermFor,
  SUPPORTED_LANGUAGES,
  DEFAULT_LEARNING_LANGUAGE,
  DEFAULT_NATIVE_LANGUAGE,
  type LangCode,
  type SourceSelection,
} from "../services/language";
import { errorMessage as message } from "../lib/errorMessage";
import { useLanguagePrefs } from "./useLanguagePrefs";
import { updateUserLanguages } from "../services/session";
import type { Word } from "../services/words/repository";

export type TranslateMode = "word" | "paragraph";
export type TranslateStatus = "idle" | "loading" | "done" | "error";

/**
 * Pins this instance's language pair instead of reading the profile. For a surface
 * whose text has its OWN language — a media article, which the Media tab can browse in
 * a language you are not currently studying — the profile is the wrong answer: an
 * English article analyzed as Japanese resolves nothing, and when the profile's native
 * language is also English it collapses to EN→EN, which submit answers by echoing the
 * input and rendering no reader at all.
 */
export interface TranslateLangs {
  /** The language of the text being studied (the translate SOURCE). */
  learning: LangCode;
  /** The language its meanings are explained in (the TARGET); must differ. */
  native: LangCode;
}

export function useTranslate(userId: string, pinned?: TranslateLangs) {
  // SOURCE (input) defaults to the LEARNING language and TARGET (output) to the NATIVE
  // one: you type what you're studying and read its meaning in your own language. The
  // profile effect below pins both once prefs load; both stay changeable in the LangBar.
  const [source, setSource] = useState<SourceSelection>(DEFAULT_LEARNING_LANGUAGE);
  const [target, setTarget] = useState<LangCode>(DEFAULT_NATIVE_LANGUAGE);
  // Sticky: what you typed survives a tab switch. The RESULTS deliberately don't —
  // they'd be a stale mirror of saved/confidence state.
  const [input, setInput] = useStickyState(userId, "translate.input", "");
  // Recorded on SUCCESS only (see the effect below), so a failed submit (429, 413,
  // network) doesn't leave an entry that replays straight back into the same error.
  const [history, setHistory] = useStickyState<TranslateHistoryEntry[]>(
    userId,
    "translate.history",
    [],
  );
  // Set at submit, consumed at status "done". A ref, not state: it must not re-render,
  // and submit has several success exits — capturing once at the top covers them all
  // without threading a record call through each `return`.
  const pendingEntry = useRef<TranslateHistoryEntry | null>(null);
  const [status, setStatus] = useState<TranslateStatus>("idle");
  const [mode, setMode] = useState<TranslateMode>("word");
  const [error, setError] = useState<string | null>(null);

  // The language the user is LEARNING. The study surface always operates on THIS
  // language's words — the input when the user types it, else the OUTPUT, so typing
  // English while learning JA studies the Japanese translation's words. Independent of
  // the translate direction: swapping languages doesn't change what you're learning.
  const [learning, setLearning] = useState<LangCode>(DEFAULT_LEARNING_LANGUAGE);
  // The plain translation in the output box. Set by submit; distinct from study data.
  const [output, setOutput] = useState("");

  // word mode
  const [headword, setHeadword] = useState("");
  const [meanings, setMeanings] = useState<Word[]>([]);

  // paragraph mode
  const [para, setPara] = useState<ParagraphTranslation | null>(null);
  // True while the reader (analysis + per-word lookups) is still loading AFTER the
  // sentence translation is shown, so the UI can render that with a spinner below.
  const [readerLoading, setReaderLoading] = useState(false);
  const [analyzedInput, setAnalyzedInput] = useState("");
  // True while the ON-DEMAND sentence gloss is in flight (see loadGloss).
  const [glossLoading, setGlossLoading] = useState(false);

  // Per-SENSE state, keyed by dictionary wordId — shared by both modes so the popover
  // can add an exact sense (つらい without からい).
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState<Set<string>>(new Set());
  const [confidence, setConfidence] = useState<Map<string, number>>(new Map());
  const [userWordIds, setUserWordIds] = useState<Map<string, string>>(new Map());
  /** Senses whose knowledge state has already been fetched — see syncSenseState. */
  const syncedIds = useRef<Set<string>>(new Set());

  // The user's sub-lists (the add buttons' menu offers these + "new"). A null
  // destination means just ALL.
  const [lists, setLists] = useState<List[]>([]);
  useEffect(() => {
    listUserLists(userId).then(setLists).catch((e) => console.warn("useTranslate: failed to load sub-lists", e));
  }, [userId]);

  // The user's effective restrictions. Defaults until loaded, so the first submit still
  // has a sane cap. The edge re-enforces server-side; this copy is for instant feedback.
  const [limits, setLimits] = useState<UserLimits>(DEFAULT_LIMITS);
  useEffect(() => {
    getUserLimits(userId).then(setLimits).catch((e) => console.warn("useTranslate: failed to load limits (using defaults)", e));
  }, [userId]);

  // Seeds cold-start stability for un-quizzed words, so a known vocabulary doesn't all
  // start at 0. null until calibrated → seedStability returns null → plain cold start.
  const [level, setLevel] = useState<LevelValue | null>(null);
  useEffect(() => {
    getUserLevel(userId).then(setLevel).catch((e) => console.warn("useTranslate: failed to load level (no cold-start seeding)", e));
  }, [userId]);

  // Default both directions from the profile prefs, falling back to the registry
  // defaults for a fresh guest.
  //
  // Applied whenever the profile resolves — but NEVER over an explicit choice.
  //
  // `prefs` starts at the registry defaults and is replaced when the profile load
  // lands, so an unguarded effect re-runs at that moment and overwrites whatever the
  // user picked in between: choose English quickly enough after opening Translate and
  // the load snaps it back to Japanese, which is the exact thing changeLearning exists
  // to prevent. (It also made the setLearning test flaky — under load the profile
  // resolves after the act(), so the assertion saw the clobbered value.)
  //
  // Guarded on the USER having chosen, not on having run once: the effect's first run
  // carries the DEFAULTS, so a run-once latch would mean the saved profile never
  // applied at all.
  //
  // A PINNED pair (see TranslateLangs) wins outright and the profile is never read into
  // this instance: the text's own language decides, not what the user happens to study.
  const prefs = useLanguagePrefs(userId);
  const userPickedLearning = useRef(false);
  const pinnedLearning = pinned?.learning;
  const pinnedNative = pinned?.native;
  useEffect(() => {
    if (pinnedLearning && pinnedNative) {
      setSource(pinnedLearning);
      setTarget(pinnedNative);
      setLearning(pinnedLearning);
      return;
    }
    if (userPickedLearning.current) return;
    setSource(prefs.learning);
    setTarget(prefs.native);
    setLearning(prefs.learning);
  }, [prefs, pinnedLearning, pinnedNative]);

  /**
   * Change the language being studied — and PERSIST it, because "I'm learning: X" is
   * the profile's learning language, not a per-tab setting.
   *
   * It used to be local state seeded from the profile and never written back, so the
   * app held two answers to one question: this picker, and the profile row that Learn,
   * the placement quiz and Media all read. Switch to English here and the placement
   * quiz still dealt Japanese cards, with nothing on screen explaining why — the quiz
   * was reading a value the user had, as far as they could tell, already changed.
   *
   * Optimistic: the local state moves first so the picker never lags, and a failed
   * write is logged rather than surfaced — the session still behaves as asked, it just
   * won't be remembered, which is not worth an error dialog mid-translation.
   */
  const changeLearning = useCallback(
    (lang: LangCode) => {
      // Claim the choice BEFORE the state write, so a profile load that resolves in
      // the same tick can no longer overwrite it (see the prefs effect above).
      userPickedLearning.current = true;
      setLearning(lang);
      updateUserLanguages({ userId, learningLanguage: lang }).catch((e) =>
        console.warn("useTranslate: failed to persist the learning language", e),
      );
    },
    [userId],
  );

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

  // Submit is a BUTTON, never Enter (the IME confirms kanji with Enter). The overrides
  // let swap() translate the swapped text/langs without waiting for a setState round-trip.
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
      // ROMAJI → KANA, for the LOOKUP only. Typing "neko" while the source says Japanese
      // found nothing: jmdict_lookup misses on Latin, and the edge's off-script guard
      // then (correctly) refuses to buy an MT translation of Latin submitted as JA — so
      // the answer was silence. Converting to ねこ first makes it an ordinary query.
      //
      // Only when the source is EXPLICITLY Japanese. Under auto-detect "neko" is
      // genuinely ambiguous with English (as are same, mono, kite, ka…), and guessing
      // would break real English lookups to fix a rarer case. Returns the input
      // untouched unless the WHOLE string converts, so "cat" and "PDF" are unaffected.
      // The typed text is what stays in the box and what the echo below returns; only
      // the search term changes.
      const searchText = searchTermFor(text, src);
      const resolvedSource = resolveSourceLanguage(searchText, src);

      // NOTHING TO TRANSLATE → echo the input, make no API calls, render no reader.
      // Two ways to get here, and the second is why the dropdown alone is not enough:
      // the source selector may say Japanese while the text is plainly English, and
      // translating EN→EN is a paid call whose best possible answer is the input. The
      // edge rejects source === target with a 400 anyway, so without this the user got
      // an error where the correct response was "here it is, unchanged".
      // Detection runs on searchText, so converted romaji reads as Japanese and does
      // NOT trip this.
      if (resolvedSource === tgt || detectLanguage(searchText) === tgt) {
        setOutput(text);
        setMeanings([]);
        setPara(null);
        setAnalyzedInput("");
        setHeadword(text);
        setMode("word");
        setStatus("done");
        return;
      }

      // The STUDY orients on the LEARNING language; `native` is the explanation side.
      // Typing the learning language studies the input directly; otherwise the input is
      // translated INTO the learning language and THAT is studied.
      const typedLearning = resolvedSource === learning;
      // `native` must NOT be the learning language, so when the target is also the
      // learning language fall back to another supported one rather than ever doing a
      // learning→learning lookup.
      const native: LangCode = !typedLearning
        ? resolvedSource
        : tgt !== learning
          ? tgt
          : SUPPORTED_LANGUAGES.find((l) => l.code !== learning)?.code ?? tgt;
      setNativeLang(native);

      // Which senses are saved, at what confidence, so the UI can mark them up front.
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
        // AUTHORITATIVE for the new result, REPLACING what came before — so the live
        // reader's incremental record restarts here, or a sense it had already fetched
        // would be skipped forever even though this reset dropped it.
        syncedIds.current = new Set(ids);
      };

      // CASE B, single typed word → surface the learning language's DISTINCT
      // equivalents (bat → バット AND 蝙蝠), each studied as a learning-language word.
      // (Translating to one string would collapse to just the top equivalent.)
      if (!typedLearning) {
        const inputTokens = await analyze(searchText, resolvedSource);
        if (isSingleWord(inputTokens, resolvedSource)) {
          const enja = await lookupWord({ input: searchText, sourceLang: resolvedSource, targetLang: learning });
          // Distinct candidate writings in the EN→JA rank order, capped. That ranking
          // already puts the common, relevant equivalents ahead of tangential ones.
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
          // rest contribute their primary. ONE batched lookup, not N per-word calls.
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
        learningText = searchText;
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

      // Sentence → reader. The per-user char limit guards the PAID gloss, so it's
      // skipped under skipGloss (a long article is free to analyze in full). The edge
      // re-checks as the hard gate.
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

      // Show the TRANSLATION as soon as it's known, then stream the reader in below
      // (kuromoji's first load + the lookups are the slow part). Status flips to "done"
      // with readerLoading true until the tokens/meanings arrive.
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

  // Commit the pending entry once a submit succeeds. Keyed on the status transition
  // rather than called inside submit, because submit has several success exits and only
  // ONE failure path — this records all of the former and none of the latter. Clearing
  // the ref makes it idempotent against an unrelated re-render at "done".
  useEffect(() => {
    if (status !== "done") return;
    const entry = pendingEntry.current;
    if (!entry) return;
    pendingEntry.current = null;
    setHistory((prev) => pushEntry(prev, entry));
  }, [status, setHistory]);

  /**
   * Re-run a history entry: restore the text AND the direction it was translated in,
   * then submit. Both the LangBar and the request are set from the entry, so what the
   * user sees matches what actually ran.
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

  /**
   * Fetch the sentence-by-sentence translation for the ALREADY-analyzed paragraph and
   * fold it into `para.sentences`, so the reader's "Show translation" toggle can PAY ON
   * DEMAND: an article analyzed with `skipGloss` costs nothing to open, and only a
   * reader who presses the toggle buys a gloss.
   *
   * Idempotent + single-flight, so double-clicking can't buy it twice. A failure is
   * non-fatal — the reader keeps rendering, just without English.
   */
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
      // Through the CACHE, so sentences already bought one at a time are free here.
      const glosses = await glossSentences({
        segments: spans.map((s) => s.text),
        sourceLang: learning,
        targetLang: nativeLang, // resolved by submit — the explanation language
      });
      const sentences = spans.map((s, i) => ({ ...s, gloss: glosses[i] ?? null }));
      // Guard a late response landing on a DIFFERENT paragraph (the user moved on).
      setPara((prev) => (prev && prev.tokens === para.tokens ? { ...prev, sentences } : prev));
    } catch (e) {
      setError(message(e));
    } finally {
      setGlossLoading(false);
    }
  }, [analyzedInput, para, glossLoading, limits, learning, nativeLang]);

  /**
   * Buy the English for ONE sentence — the reader's punctuation affordance — and fold
   * it into `para.sentences`. The cheap half of loadGloss, and idempotent: a sentence
   * that already has a gloss is a no-op, so a second tap costs nothing.
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
          // Seed every sentence from the cache while we're here, so earlier taps and
          // this one all show at once without another request.
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
   * Fill in the knowledge state for senses the LIVE reader has found, so it can colour
   * them without a submit — otherwise a word known at 5/5 renders as "addable" while
   * typing, which is worse than no colour: it says you don't have a word you do.
   *
   * MERGES, never replaces: submit's loadSenseState owns the authoritative reset, so
   * this can't wipe it or race an in-flight save's optimistic mark.
   *
   * Free (one `user_words` read, no dictionary, no MT) and each sense is fetched ONCE —
   * the live reader re-analyzes on every pause, and re-asking on every keystroke is how
   * a free path stops being free.
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

  /** Add/tag senses to ALL (no listId) or into a sub-list. Idempotent, so it both
   *  creates the entry and adds the tag. Throws on failure, so the button can stay
   *  in its menu/idle state. */
  const addWords = useCallback(
    async (words: Word[], listId?: string) => {
      setError(null);
      // One batched RPC instead of N saves (all-or-nothing in a single transaction).
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

  // Distinct CONTENT words' PRIMARY senses (particles/auxiliaries excluded by POS),
  // partitioned in ONE pass into addable (not yet saved) and reviewable. addableCards
  // carries ALL senses of each new word so the quiz can cycle meanings and add a chosen
  // one; addablePrimaries is the primary-only view for the count and "Add all".
  const { addablePrimaries, reviewablePrimaries, addableCards } = useMemo(() => {
    const addable: Word[] = [];
    const reviewable: Word[] = [];
    const cards: Word[][] = [];
    if (para) {
      const seen = new Set<string>();
      for (const tok of para.tokens) {
        if (!isContentPos(tok.pos) || seen.has(wordKey(tok))) continue;
        seen.add(tok.text);
        // Lead with the sense the SENTENCE used — kuromoji read this surface in
        // context, so a homograph shows the meaning actually on the page. No-op
        // unless the reading genuinely separates the senses.
        const senses = orderSensesByContextReading(para.meanings.get(wordKey(tok)) ?? [], tok.reading);
        const primary = senses[0];
        if (!primary) continue;
        if (saved.has(primary.wordId)) reviewable.push(primary);
        else { addable.push(primary); cards.push(senses); }
      }
    }
    return { addablePrimaries: addable, reviewablePrimaries: reviewable, addableCards: cards };
  }, [para, saved]);

  // "Show in context": word → the sentences it appeared in. Split HERE rather than
  // read from `para.sentences`, because splitting is free and only the GLOSS costs — so
  // a skipGloss analysis has empty `sentences` yet still deserves context. Glosses
  // already loaded are folded back in by sentence offset.
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
    // setLearning PERSISTS to the profile — see changeLearning. Every other surface
    // (Learn, the placement quiz, Media) reads that row, so a local-only change would
    // silently disagree with them.
    learning, setLearning: changeLearning,
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
