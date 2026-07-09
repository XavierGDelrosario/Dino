// Drives the adaptive placement quiz (#10, "Find my level"). Each round shows a
// batch of words at ONE proficiency band; the user taps the ones they DON'T know;
// submitting folds the known-fraction into a binary search over the bands
// (services/calibration) that converges — in ~log2(bands) rounds — on the hardest
// band the user knows ≥ 80% of. That band is persisted as users.level, which then
// seeds the SRS for words added later (seedStability), so a known vocabulary
// doesn't all cold-start at 0.
//
// Side effects, per round: every word the user does NOT mark "don't know" is added
// to their vocabulary (ALL) at FULL confidence — they just told us they know it —
// via the non-clobbering #10 cold-start seed (so a word already under review keeps
// its real strength). Unknown words are left untouched, and NO per-word reviews are
// recorded (it's a placement test, not a study session).
import { useCallback, useEffect, useRef, useState } from "react";
import { getUserProfile } from "../services/session";
import {
  startBandSearch,
  advanceBandSearch,
  estimateLevel,
  setUserLevel,
  setUserProficiencyBand,
  type BandSearch,
  type CalibrationSample,
} from "../services/calibration";
import { fetchLearnWords } from "../services/learn";
import { saveDictionaryWord, saveDictionaryWords } from "../services/words/userWords";
import { getDifficulty } from "../services/difficulty";
import { proficiencyFrameworkFor, labelForBand } from "../services/proficiency";
import {
  DEFAULT_LEARNING_LANGUAGE,
  DEFAULT_NATIVE_LANGUAGE,
  type LangCode,
} from "../services/language";
import { errorMessage as message } from "../lib/errorMessage";
import type { Word } from "../services/words/repository";

export type CalibrationStatus =
  | "loading" // fetching the next batch
  | "reviewing" // a batch is on screen
  | "done" // converged; level persisted
  | "unavailable" // the learning language has no curated band data
  | "error";

/** Words per round. Small + fixed so a round is a quick glance-and-tap. */
export const CALIBRATION_BATCH = 8;

// Bound-morpheme JMdict POS codes — an entry whose PRIMARY sense is ONLY these is a
// prefix/suffix/counter/auxiliary, not a standalone word a learner can self-rate
// ("第", "化", "さん"). Mirrors learn_words_at_band's server-side c_affix_pos; kept as
// a client backstop since that filter is inclusive (any non-affix sense passes) and
// may not be deployed to every DB. n-suf/n-pref included (化/系/感 are noun-affixes).
const AFFIX_POS = new Set([
  "pref", "suf", "ctr", "aux", "aux-v", "aux-adj", "cop", "cop-da", "n-suf", "n-pref",
]);
const isAffixOnly = (w: Word): boolean =>
  !!w.partOfSpeech?.length && w.partOfSpeech.every((p) => AFFIX_POS.has(p));

/** Initial memory strength (days) seeded for a word the user marks as KNOWN.
 *  confidence_from_stability(40) = 5 (its ≥ 35 bucket), so a known word lands in
 *  the vocabulary at full confidence. Uses the #10 cold-start SEED path
 *  (saveDictionaryWord initialStability), which sets a NEW word's confidence but
 *  never clobbers a word already under review. */
const KNOWN_WORD_STABILITY = 40;

export function useCalibration(userId: string) {
  // Directions from the profile (learning = the tested language, native = meaning
  // language, though calibration shows no meanings). Loaded once.
  const langs = useRef<{ learning: LangCode; native: LangCode }>({
    learning: DEFAULT_LEARNING_LANGUAGE,
    native: DEFAULT_NATIVE_LANGUAGE,
  });

  const [status, setStatus] = useState<CalibrationStatus>("loading");
  const [search, setSearch] = useState<BandSearch | null>(null);
  const [cards, setCards] = useState<Word[]>([]);
  const [unknown, setUnknown] = useState<Set<number>>(new Set());
  const [round, setRound] = useState(0);
  // The PROFICIENCY band the search converged on (1 = easiest) — the result the
  // learner sees ("N3"). Stored to users.proficiency_band. DISTINCT from the
  // difficulty level (users.level) estimated below.
  const [band, setBand] = useState<number | null>(null);
  // Per-word DIFFICULTY samples ({frequency-difficulty, known→grade5/unknown→grade1})
  // accumulated across rounds. estimateLevel() folds them into a difficulty-axis
  // level for users.level — the value the embeddings/domain filter (#12) and
  // seedStability consume (they compare against word frequency, not the JLPT band).
  const samples = useRef<CalibrationSample[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Running count of KNOWN words added to the vocabulary this session (shown on the
  // result screen). Bands don't overlap, so a word is offered in at most one round.
  const [addedCount, setAddedCount] = useState(0);
  // The words the user marked "don't know", accumulated ACROSS rounds (each round's
  // cards/unknown reset), to list on the result screen so they can study them.
  const [missed, setMissed] = useState<Word[]>([]);
  // Missed words the user chose to ADD from the result list (for the ✓ state).
  const [savedMissedIds, setSavedMissedIds] = useState<Set<string>>(new Set());

  // Add a missed word from the result list. COLD start (no seed) — the user said
  // they DON'T know it, so it enters the SRS as new, unlike the known-word seed.
  const addMissedWord = useCallback(
    async (word: Word, listId?: string) => {
      await saveDictionaryWord({ userId, word, listId });
      setSavedMissedIds((s) => new Set(s).add(word.wordId));
    },
    [userId],
  );

  const framework = proficiencyFrameworkFor(langs.current.learning);

  // Fetch one band's batch. excludeSeen:true so words already in the user's
  // vocabulary — including ones an earlier round/retake just added at full
  // confidence — don't reappear (the fix for "repeats on retry"). A first-time
  // calibration (empty vocab) is unaffected; on a retake the known-fraction then
  // reflects the words the user hasn't already mastered. Empty result = no fresh
  // words for the band (proficiency not ingested, or all seen); the caller decides
  // whether that's "unavailable" (first round) or a reason to stop.
  const fetchBand = useCallback(async (band: number): Promise<Word[]> => {
    const cardLists = await fetchLearnWords({
      band,
      source: langs.current.learning,
      target: langs.current.native,
      limit: CALIBRATION_BATCH,
      excludeSeen: true,
    });
    // One word per card (the primary sense) — know/don't-know needs no meanings.
    // Drop bare affixes (prefixes/suffixes/counters): a learner can't rate "第" alone.
    return cardLists
      .map((senses) => senses[0])
      .filter(Boolean)
      .filter((w) => !isAffixOnly(w));
  }, []);

  // Converge: persist BOTH axes (each on its own column), then show the result.
  // Fire-and-forget — a failed write just means that value isn't stored; the result
  // still shows. The two axes are deliberately NOT collapsed into one number:
  //   · proficiency_band ← the JLPT search result (the "N3" the learner sees)
  //   · users.level      ← estimateLevel() over the tested words' FREQUENCY, the
  //                        difficulty-axis value the embeddings/seed consume.
  const finalize = useCallback(
    (resultBand: number) => {
      setBand(resultBand);
      setStatus("done");
      void setUserProficiencyBand(userId, resultBand).catch((e) =>
        console.warn("calibration: failed to persist proficiency band", e),
      );
      const difficulty = estimateLevel(samples.current); // null → beginner / cold-start
      void setUserLevel(userId, difficulty).catch((e) =>
        console.warn("calibration: failed to persist difficulty level", e),
      );
    },
    [userId],
  );

  // Load a band into a fresh round, or finish if the band is empty mid-search.
  const loadRound = useCallback(
    async (next: BandSearch, roundNo: number, firstRound: boolean) => {
      setStatus("loading");
      setError(null);
      try {
        const batch = await fetchBand(next.band);
        if (batch.length === 0) {
          // No words for this band. First round → the language/level data isn't
          // available at all; otherwise finish with the best band passed so far.
          if (firstRound) setStatus("unavailable");
          else finalize(next.best);
          return;
        }
        setSearch(next);
        setCards(batch);
        setUnknown(new Set());
        setRound(roundNo);
        setStatus("reviewing");
      } catch (e) {
        setError(message(e));
        setStatus("error");
      }
    },
    [fetchBand, finalize],
  );

  const begin = useCallback(() => {
    const fw = proficiencyFrameworkFor(langs.current.learning);
    if (!fw) {
      setStatus("unavailable");
      return;
    }
    const maxBand = fw.bands[fw.bands.length - 1]?.value ?? 1;
    setBand(null);
    samples.current = [];
    void loadRound(startBandSearch(maxBand), 1, true);
  }, [loadRound]);

  // Load prefs once, then start the first round.
  useEffect(() => {
    let active = true;
    getUserProfile(userId)
      .then((p) => {
        langs.current = {
          learning: (p?.learningLanguage ?? DEFAULT_LEARNING_LANGUAGE) as LangCode,
          native: (p?.nativeLanguage ?? DEFAULT_NATIVE_LANGUAGE) as LangCode,
        };
      })
      .catch((e) => console.warn("useCalibration: failed to load language prefs", e))
      .finally(() => {
        if (active) begin();
      });
    return () => {
      active = false;
    };
    // begin/langs are stable for the life of the hook (keyed on userId upstream).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  const toggle = useCallback((i: number) => {
    setUnknown((s) => {
      const next = new Set(s);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }, []);

  const submit = useCallback(() => {
    if (!search || submitting || status !== "reviewing") return;
    setSubmitting(true);

    // Record a DIFFICULTY sample per shown word (frequency-difficulty × known?5:1),
    // for the users.level estimate at the end. Words with no frequency are skipped.
    cards.forEach((word, i) => {
      const difficulty = getDifficulty(word).level;
      if (difficulty != null) {
        samples.current.push({ difficulty, grade: unknown.has(i) ? 1 : 5 });
      }
    });

    // Remember the words marked "don't know" (accumulated across rounds) to list on
    // the result screen. Bands don't overlap, so no dedupe needed.
    const missedThisRound = cards.filter((_, i) => unknown.has(i));
    if (missedThisRound.length > 0) setMissed((m) => [...m, ...missedThisRound]);

    // Add every word NOT marked "don't know" to the vocabulary (ALL) at full
    // confidence — the user just told us they know it — in ONE transaction.
    // saveDictionaryWords returns the rows ACTUALLY written, so addedCount reflects
    // real saves (not an optimistic guess) and a failure surfaces here instead of
    // being swallowed per word. Doesn't block the round advance (kept snappy).
    const known = cards.filter((_, i) => !unknown.has(i));
    if (known.length > 0) {
      void saveDictionaryWords({ userId, words: known, seedFor: () => KNOWN_WORD_STABILITY })
        .then((saved) => setAddedCount((n) => n + saved.length))
        .catch((e) => console.warn("calibration: failed to save known words", e));
    }

    const knownFraction = known.length / cards.length;
    const step = advanceBandSearch(search, knownFraction);
    setSubmitting(false);
    if (step.done) finalize(step.level);
    else void loadRound(step.search, round + 1, false);
  }, [search, submitting, status, cards, unknown, userId, round, finalize, loadRound]);

  const restart = useCallback(() => {
    setSearch(null);
    setCards([]);
    setUnknown(new Set());
    setBand(null);
    setAddedCount(0);
    setMissed([]);
    setSavedMissedIds(new Set());
    samples.current = [];
    begin();
  }, [begin]);

  return {
    status,
    cards,
    unknown,
    toggle,
    submit,
    submitting,
    round,
    error,
    restart,
    /** Learner-facing label of the final PROFICIENCY band ("N3"), or null. */
    levelLabel: band != null && framework ? labelForBand(framework, band) : null,
    /** Known words added to the vocabulary (ALL) at full confidence this session. */
    addedCount,
    /** Words the user marked "don't know" across all rounds (for the result list). */
    missed,
    /** Add a missed word to the vocabulary (cold start), optionally to a sub-list. */
    addMissedWord,
    /** Missed-word ids already added from the result list (for the ✓ state). */
    savedMissedIds,
    /** Count marked "don't know" this round (for the submit affordance). */
    unknownCount: unknown.size,
    batchSize: cards.length,
  };
}
