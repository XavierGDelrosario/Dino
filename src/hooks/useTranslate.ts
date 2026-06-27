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
import { lookupWord, lookupWordsBatch, translateParagraph, type ParagraphTranslation } from "../services/lookup";
import { translate } from "../services/translation";
import { saveDictionaryWord, saveDictionaryWords, getUserWordStates } from "../services/words/userWords";
import { listUserLists, createList, type List } from "../services/lists";
import { getUserLimits, DEFAULT_LIMITS, type UserLimits } from "../services/entitlements";
import { recordReview } from "../services/review";
import { getUserLevel, seedStability } from "../services/calibration";
import { getUserProfile } from "../services/session";
import { getDifficulty, type LevelValue } from "../services/difficulty";
import { expandDomain } from "../services/domain";
import { isExplicitSuggestion } from "../services/contentSafety";
import { mapLimit } from "../lib/concurrency";
import { MAX_TRANSLATION_CONCURRENCY } from "../services/translation";
import {
  analyze,
  isSingleWord,
  isContentPos,
  resolveSourceLanguage,
  SUPPORTED_LANGUAGES,
  DEFAULT_NATIVE_LANGUAGE,
  DEFAULT_LEARNING_LANGUAGE,
  type LangCode,
  type SourceSelection,
} from "../services/language";
import { errorMessage as message } from "../lib/errorMessage";
import type { Word } from "../services/words/repository";

export type TranslateMode = "word" | "paragraph";
export type TranslateStatus = "idle" | "loading" | "done" | "error";

export function useTranslate(userId: string) {
  const [source, setSource] = useState<SourceSelection>(DEFAULT_NATIVE_LANGUAGE);
  const [target, setTarget] = useState<LangCode>(DEFAULT_LEARNING_LANGUAGE);
  const [input, setInput] = useState("");
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

  // Per-SENSE state, keyed by dictionary wordId — shared by both modes so the
  // popover/results can add an exact sense (e.g. つらい without からい).
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState<Set<string>>(new Set());
  const [confidence, setConfidence] = useState<Map<string, number>>(new Map());
  const [userWordIds, setUserWordIds] = useState<Map<string, string>>(new Map());

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

  // Default the directions from the user's profile prefs (Profile page). SOURCE =
  // the user's NATIVE language (you type in your language), TARGET/LEARNING = what
  // they're learning → you get the translation to study. A user who never set these
  // has NULL profile values, so fall back to the SAME defaults the Profile page
  // shows (DEFAULT_NATIVE/LEARNING_LANGUAGE) — otherwise the input would sit on
  // "Detect language" while the Profile claims a native language, which is the bug
  // this guards against. Both directions are still freely changeable in the LangBar.
  useEffect(() => {
    getUserProfile(userId).then((p) => {
      const native = (p?.nativeLanguage ?? DEFAULT_NATIVE_LANGUAGE) as LangCode;
      const learn = (p?.learningLanguage ?? DEFAULT_LEARNING_LANGUAGE) as LangCode;
      setSource(native);
      setTarget(learn);
      setLearning(learn);
    }).catch((e) => console.warn("useTranslate: failed to load language prefs", e));
  }, [userId]);

  // The explanation language the reader's words were studied in (set by submit);
  // domain expansion looks related words up in the same learning→native direction.
  const [nativeLang, setNativeLang] = useState<LangCode>("EN");
  const [domainLoading, setDomainLoading] = useState(false);

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
  }) => {
    const text = (override?.text ?? input).trim();
    if (!text || status === "loading" || readerLoading) return;
    const src = override?.source ?? source;
    const tgt = override?.target ?? target;
    setStatus("loading");
    setReaderLoading(false);
    setError(null);
    try {
      const resolvedSource = resolveSourceLanguage(text, src);

      // Input language == output language → nothing to TRANSLATE: echo the input,
      // no API calls, no reader. BUT never short-circuit the learning language —
      // studying it (the reader) is the point even when source==target==learning
      // (the default JA→JA case), and the type-native-to-study-its-translation flow
      // also lands here. Only echo when neither side is the learning language.
      if (resolvedSource === tgt && resolvedSource !== learning) {
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
            const jp = m.translation.trim().normalize("NFC");
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
        learningText = disp.translation.trim().normalize("NFC");
        outputText = learningText;
      }

      // Analyze + study the LEARNING text in the learning → native direction.
      const tokens = await analyze(learningText, learning);

      if (isSingleWord(tokens, learning)) {
        // Resolve the dictionary form from the CONTENT token (行った → 行く).
        const contentTok = tokens.find((t) => t.pos !== null && isContentPos(t.pos));
        const lemma = contentTok?.lemma ?? contentTok?.text ?? learningText;
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
      // guard) up front; the edge function re-checks as the hard gate.
      if (learningText.length > limits.paragraphCharLimit) {
        setError(
          `This text is ${learningText.length} characters; the limit is ${limits.paragraphCharLimit}. Please shorten it.`
        );
        setStatus("error");
        return;
      }
      setAnalyzedInput(learningText.normalize("NFC"));
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
  }, [status, target, source, input, output, submit]);

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
  const exploreDomain = useCallback(async (): Promise<Word[]> => {
    if (!para || domainLoading) return [];
    setDomainLoading(true);
    setError(null);
    try {
      // Seeds = each distinct content word's primary JMdict entry (non-MT only).
      const seedEntryIds: string[] = [];
      const seenE = new Set<string>();
      for (const tok of para.tokens) {
        if (!isContentPos(tok.pos)) continue;
        const eid = para.meanings.get(tok.text)?.[0]?.jmdictEntryId;
        if (eid && !seenE.has(eid)) { seenE.add(eid); seedEntryIds.push(eid); }
      }
      const candidates = await expandDomain({ seedEntryIds, userLevel: level, limit: 18 });
      // Resolve each candidate to a quizzable Word (learning→native). Prefer the
      // sense whose STABLE entry id matches the embedded candidate (lookupWord
      // matches by surface, so a homograph would otherwise resolve to the most
      // frequent entry, not the one the word map clustered — see #1 identity).
      const looked = await mapLimit(candidates, MAX_TRANSLATION_CONCURRENCY, (c) =>
        lookupWord({ input: c.writing, sourceLang: learning, targetLang: nativeLang })
          .then((r) => r.meanings.find((m) => m.jmdictEntryId === c.entryId) ?? r.meanings[0] ?? null)
          .catch(() => null),
      );
      const words: Word[] = [];
      const seenW = new Set<string>();
      for (const w of looked) {
        if (!w || saved.has(w.wordId) || seenW.has(w.wordId)) continue;
        // CONTENT SAFETY (defense in depth): re-check the EXACT gloss the quiz will
        // show — the resolved Word can differ from the vetted related_words gloss.
        if (isExplicitSuggestion(w.input, w.translation)) continue;
        seenW.add(w.wordId);
        words.push(w);
      }
      return words;
    } catch (e) {
      setError(message(e));
      return [];
    } finally {
      setDomainLoading(false);
    }
  }, [para, level, learning, nativeLang, saved, domainLoading]);

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
  const { addablePrimaries, reviewablePrimaries } = useMemo(() => {
    const addable: Word[] = [];
    const reviewable: Word[] = [];
    if (para) {
      const seen = new Set<string>();
      for (const tok of para.tokens) {
        if (!isContentPos(tok.pos) || seen.has(tok.text)) continue;
        seen.add(tok.text);
        const primary = para.meanings.get(tok.text)?.[0];
        if (!primary) continue;
        (saved.has(primary.wordId) ? reviewable : addable).push(primary);
      }
    }
    return { addablePrimaries: addable, reviewablePrimaries: reviewable };
  }, [para, saved]);

  return {
    source, setSource, target, setTarget, input, setInput,
    status, mode, error,
    // the language being learned (study/add/quiz target)
    learning, setLearning,
    // Google-Translate-style output box + swap (langs + text + re-translate)
    output, swap,
    // shared per-sense state
    saved, saving, confidence, addSense, markUnknown,
    // word mode
    headword, meanings,
    // paragraph mode
    para, analyzedInput, readerLoading,
    // extract-and-quiz (#9): new content words (learn) + saved ones (review) +
    // the state-sync callback the quiz uses after each grade.
    addablePrimaries, reviewablePrimaries,
    addableCount: addablePrimaries.length,
    reviewableCount: reviewablePrimaries.length, applyReview,
    // #12 domain expansion: study related domain words at your level.
    exploreDomain, domainLoading,
    // add buttons: tag to ALL / a sub-list (idempotent) + create-and-tag.
    lists, addWords, createNamedList,
    submit,
  };
}
