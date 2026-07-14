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
  resolveLevelMove,
  getUserLevel,
  getUserProficiencyBand,
  setUserLevel,
  setUserProficiencyBand,
  type BandSearch,
  type CalibrationSample,
} from "../services/calibration";
import { fetchLearnWords } from "../services/learn";
import { saveDictionaryWord, saveDictionaryWords } from "../services/words/userWords";
import { getDifficulty, type LevelValue } from "../services/difficulty";
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

/** Words per round. Small + fixed so a round is a quick glance-and-tap — but not so
 *  small that one unlucky word decides a band: at 8 words a single miss moved the
 *  known-fraction by 12.5 points, straight across the 80% cutoff. 12 halves that
 *  swing, and the search now spans at most 3 bands (prior ± 1), so the quiz is no
 *  longer than it was. */
export const CALIBRATION_BATCH = 12;

// GRAMMATICAL / BOUND JMdict POS codes — an entry whose senses are ONLY these is a
// particle, conjunction, interjection, determiner, set expression, or an affix, not a
// standalone word a learner can self-rate ("は", "しかし", "もしもし", "第", "化", "さん").
// Rating one tells us nothing about their LEVEL, which is all this quiz measures.
// Mirrors learn_words_at_band's server-side c_excluded_pos (migration 20260730) — keep
// the two lists in sync; kept as a client backstop since that filter is inclusive (any
// non-grammatical sense passes) and may not be deployed to every DB.
const GRAMMATICAL_POS = new Set([
  "prt", "conj", "exp", "int", "adj-pn",
  "pref", "suf", "n-suf", "n-pref",
  "ctr", "aux", "aux-v", "aux-adj", "cop", "cop-da",
]);
const isAffixOnly = (w: Word): boolean =>
  !!w.partOfSpeech?.length && w.partOfSpeech.every((p) => GRAMMATICAL_POS.has(p));

/** BASE memory strength (days) seeded for a word the user marks as KNOWN.
 *  confidence_from_stability(40) = 5 (its ≥ 35 bucket), so a known word lands in
 *  the vocabulary at full confidence. Uses the #10 cold-start SEED path
 *  (saveDictionaryWord initialStability), which sets a NEW word's confidence but
 *  never clobbers a word already under review.
 *
 *  The server scales this per word (srs_ease: a word well below the user's level
 *  gets a longer seed) and FUZZES it by ±35% — without that, this one call seeds
 *  hundreds of words with an identical strength at an identical instant, and they
 *  all come due on the same day months later. That mass-review is exactly what the
 *  fuzz exists to prevent; do not "clean up" the randomness. */
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
  // The user's STORED estimates before this quiz (null = never calibrated). They
  // bound how far this run may move them — a re-calibration adjusts, it doesn't
  // re-guess (see the BandSearch header: the N2→N4 swing came from a small sample
  // being allowed to overwrite the estimate outright).
  const prior = useRef<{ band: number | null; level: LevelValue | null }>({ band: null, level: null });
  // Every word id shown this session, so a confirming round can't repeat one.
  const shown = useRef<Set<string>>(new Set());
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
  //
  // `shown` also filters within the SESSION: a borderline band is re-tested (the
  // confirming round), and the server samples that band's pool at random — with no
  // exclude-ids param it could hand back a word from the first batch, which would
  // pool the same answer twice. (excludeSeen can't cover it: the known words from
  // the first batch are saved fire-and-forget, so they may not be in the vocabulary
  // yet when the confirming round fetches.)
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
    const batch = cardLists
      .map((senses) => senses[0])
      .filter(Boolean)
      .filter((w) => !isAffixOnly(w))
      .filter((w) => !shown.current.has(w.wordId));
    batch.forEach((w) => shown.current.add(w.wordId));
    return batch;
  }, []);

  // Converge: persist BOTH axes (each on its own column), then show the result.
  // Fire-and-forget — a failed write just means that value isn't stored; the result
  // still shows. The two axes are deliberately NOT collapsed into one number:
  //   · proficiency_band ← the JLPT search result (the "N3" the learner sees)
  //   · users.level      ← estimateLevel() over the tested words' FREQUENCY, the
  //                        difficulty-axis value the embeddings/seed consume.
  //
  // BOTH are clamped to within one band of the stored prior (resolveLevelMove) —
  // the difficulty axis is estimated from the SAME small sample as the band, so it
  // swings for the same reason and needs the same damping. `null` survives only for
  // a never-calibrated user (a genuine cold start); once there IS a prior, a quiz
  // that credits nothing steps down one band rather than wiping the estimate.
  const finalize = useCallback(
    (resultBand: number) => {
      const band = resolveLevelMove(resultBand, prior.current.band);
      setBand(band);
      setStatus("done");
      void setUserProficiencyBand(userId, band).catch((e) =>
        console.warn("calibration: failed to persist proficiency band", e),
      );
      const estimate = estimateLevel(samples.current); // null → nothing credited
      const level =
        estimate == null && prior.current.level == null
          ? null // never calibrated + nothing credited → stay cold-start
          : resolveLevelMove(estimate ?? 0, prior.current.level);
      void setUserLevel(userId, level).catch((e) =>
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
        // Loop rather than return on the first empty band: a CONFIRMING round that
        // finds no fresh words still has its pooled evidence, so decide that band on
        // it (a 0-of-0 fold, which advanceBandSearch resolves from `pooled` alone)
        // and move on, instead of throwing the round away.
        let cursor = next;
        for (;;) {
          const batch = await fetchBand(cursor.band);
          if (batch.length > 0) {
            setSearch(cursor);
            setCards(batch);
            setUnknown(new Set());
            setRound(roundNo);
            setStatus("reviewing");
            return;
          }
          // No words for this band. First round → the language/level data isn't
          // available at all; otherwise finish with the best band passed so far.
          if (firstRound) {
            setStatus("unavailable");
            return;
          }
          if (!cursor.pooled) {
            finalize(cursor.best);
            return;
          }
          const step = advanceBandSearch(cursor, 0, 0);
          if (step.done) {
            finalize(step.level);
            return;
          }
          cursor = step.search;
        }
      } catch (e) {
        setError(message(e));
        setStatus("error");
      }
    },
    [fetchBand, finalize],
  );

  // Start the search. With a stored band it spans only prior ± 1 (an adjustment,
  // not a fresh guess); with none it's the old middle-out binary search.
  const begin = useCallback(() => {
    const fw = proficiencyFrameworkFor(langs.current.learning);
    if (!fw) {
      setStatus("unavailable");
      return;
    }
    const maxBand = fw.bands[fw.bands.length - 1]?.value ?? 1;
    setBand(null);
    samples.current = [];
    shown.current = new Set();
    void loadRound(startBandSearch(maxBand, prior.current.band), 1, true);
  }, [loadRound]);

  // Load prefs + the stored estimates once, then start the first round. The priors
  // must be in hand BEFORE the search starts — they set its range (prior ± 1).
  useEffect(() => {
    let active = true;
    Promise.all([getUserProfile(userId), getUserProficiencyBand(userId), getUserLevel(userId)])
      .then(([p, band, level]) => {
        langs.current = {
          learning: (p?.learningLanguage ?? DEFAULT_LEARNING_LANGUAGE) as LangCode,
          native: (p?.nativeLanguage ?? DEFAULT_NATIVE_LANGUAGE) as LangCode,
        };
        prior.current = { band, level };
      })
      .catch((e) => console.warn("useCalibration: failed to load prefs / prior level", e))
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

    // Fold the round's COUNTS (not just the fraction) into the search: a borderline
    // band is re-tested and the two batches are pooled, which needs both numbers.
    const step = advanceBandSearch(search, known.length, cards.length);
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
