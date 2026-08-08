// Drives the "Find my level" placement quiz — now a one-word-at-a-time SWIPE test
// whose level is DERIVED FROM VOCABULARY (services/calibration.levelFromVocab), not
// from one small quiz round. Each swipe saves the word (know → full-confidence seed,
// don't-know → cold start) so your growing rated vocabulary IS the saved progress,
// and the placement is a fraction over ALL your words at a band — stable (a few
// misses can't demote you) and it sharpens as you rate more.
//
// The level is only DETERMINED once there's enough coverage (VocabLevel.sufficient);
// before that the UI shows a provisional "keep rating" state. Word selection is
// adaptive: it draws around your current provisional band (±1), so it spends swipes
// where they sharpen the placement.
import { useCallback, useEffect, useRef, useState } from "react";
import { getUserProfile } from "../services/session";
import { profileToLangs } from "./useLanguagePrefs";
import {
  getVocabRatings,
  levelFromVocab,
  setUserLevel,
  setUserProficiencyBand,
  type VocabLevel,
  type VocabRating,
} from "../services/calibration";
import { fetchLearnWords } from "../services/learn";
import { saveDictionaryWord } from "../services/words/userWords";
import { getDifficulty } from "../services/difficulty";
import { proficiencyFrameworkFor, labelForBand } from "../services/proficiency";
import { DEFAULT_LEARNING_LANGUAGE, DEFAULT_NATIVE_LANGUAGE, type LangCode } from "../services/language";
import { errorMessage as message } from "../lib/errorMessage";
import type { Word } from "../services/words/repository";

export type CalibrationStatus = "loading" | "swiping" | "done" | "unavailable" | "error";

/** confidence_from_stability(40) = 5 → a word marked KNOWN lands at full confidence. */
const KNOWN_WORD_STABILITY = 40;
const PER_BAND_FETCH = 5; // words per band per fetch
const DECK_LOW = 3; // refill when this few cards remain

// GRAMMATICAL / BOUND JMdict POS — an entry whose senses are ONLY these ("は", "第")
// isn't a standalone word a learner can self-rate. Mirrors learn_words_at_band's
// server-side c_excluded_pos (migration 20260730).
const GRAMMATICAL_POS = new Set([
  "prt", "conj", "exp", "int", "adj-pn",
  "pref", "suf", "n-suf", "n-pref",
  "ctr", "aux", "aux-v", "aux-adj", "cop", "cop-da",
]);
const isAffixOnly = (w: Word): boolean =>
  !!w.partOfSpeech?.length && w.partOfSpeech.every((p) => GRAMMATICAL_POS.has(p));

/**
 * @param langs the pair to place the user in. OPTIONAL, and passing it matters: the
 *   quiz is launched from a screen that already HAS a language picker (Learn), and
 *   without this it re-read the profile instead — so choosing English there and
 *   pressing "Find my level" still dealt Japanese cards, because the profile column
 *   was untouched (null → the registry default). One screen, two answers. Omit it
 *   only where the caller genuinely has no opinion; then the profile decides.
 */
export function useCalibration(
  userId: string,
  langs?: { learning: LangCode; native: LangCode },
) {
  // Destructured to PRIMITIVES on purpose: callers pass `{ learning, native }` inline,
  // which is a new object every render, so depending on it below would reload the deck
  // forever. The two codes are stable values.
  const learningPref = langs?.learning;
  const nativePref = langs?.native;

  const langsRef = useRef<{ learning: LangCode; native: LangCode }>({
    learning: DEFAULT_LEARNING_LANGUAGE,
    native: DEFAULT_NATIVE_LANGUAGE,
  });
  const maxBand = useRef(1);
  const baseline = useRef<VocabRating[]>([]); // rated vocabulary before this session
  const session = useRef<VocabRating[]>([]); // this session's swipes
  const shown = useRef<Set<string>>(new Set()); // word ids offered this session
  const fetching = useRef(false);

  const [status, setStatus] = useState<CalibrationStatus>("loading");
  const [deck, setDeck] = useState<Word[]>([]);
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [live, setLive] = useState<VocabLevel | null>(null);
  const [known, setKnown] = useState(0);
  const [unknown, setUnknown] = useState(0);
  const [tagged, setTagged] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const recompute = useCallback((): VocabLevel => {
    const l = levelFromVocab([...baseline.current, ...session.current], maxBand.current);
    setLive(l);
    return l;
  }, []);

  // Draw words around `band` (band ± 1), interleaved, affix-filtered, deduped.
  const fetchAround = useCallback(async (band: number): Promise<Word[]> => {
    const bands = [band, band - 1, band + 1].filter((b) => b >= 1 && b <= maxBand.current);
    const batches = await Promise.all(
      bands.map((b) =>
        fetchLearnWords({
          band: b,
          source: langsRef.current.learning,
          target: langsRef.current.native,
          limit: PER_BAND_FETCH,
          excludeSeen: true,
        }),
      ),
    );
    const cols = batches.map((b) => b.map((senses) => senses[0]).filter(Boolean));
    const out: Word[] = [];
    for (let i = 0; i < PER_BAND_FETCH; i++) for (const col of cols) if (col[i]) out.push(col[i]);
    return out.filter((w) => !isAffixOnly(w)).filter((w) => !shown.current.has(w.wordId));
  }, []);

  const refill = useCallback(
    async (band: number) => {
      if (fetching.current) return;
      fetching.current = true;
      try {
        const batch = await fetchAround(band);
        batch.forEach((w) => shown.current.add(w.wordId));
        if (batch.length) setDeck((d) => [...d, ...batch]);
      } catch (e) {
        console.warn("calibration: refill failed", e);
      } finally {
        fetching.current = false;
      }
    },
    [fetchAround],
  );

  const load = useCallback(async () => {
    setStatus("loading");
    setError(null);
    try {
      // The CALLER's pair wins when it has one — it is what the user picked on the
      // screen they pressed the button from. Only fall back to the profile when the
      // caller has no opinion.
      langsRef.current =
        learningPref && nativePref
          ? { learning: learningPref, native: nativePref }
          : profileToLangs(await getUserProfile(userId).catch(() => null));
      if (!proficiencyFrameworkFor(langsRef.current.learning)) {
        setStatus("unavailable");
        return;
      }
      const base = await getVocabRatings(userId, langsRef.current.learning);
      if (!base) {
        setStatus("unavailable");
        return;
      }
      baseline.current = base.ratings;
      maxBand.current = base.maxBand;
      session.current = [];
      shown.current = new Set();
      setKnown(0);
      setUnknown(0);
      setTagged(new Set());
      const l = levelFromVocab(base.ratings, base.maxBand);
      setLive(l);
      const start = l.band > 0 ? l.band : Math.ceil(base.maxBand / 2);
      const batch = await fetchAround(start);
      batch.forEach((w) => shown.current.add(w.wordId));
      if (batch.length === 0) {
        setStatus("unavailable");
        return;
      }
      setDeck(batch);
      setIndex(0);
      setRevealed(false);
      setStatus("swiping");
    } catch (e) {
      setError(message(e));
      setStatus("error");
    }
  }, [userId, fetchAround, learningPref, nativePref]);

  useEffect(() => {
    void load();
  }, [load]);

  const rate = useCallback(
    (didKnow: boolean) => {
      const word = deck[index];
      if (!word) return;
      // Both verdicts save to the vocabulary (ALL): known → full-confidence seed,
      // don't-know → cold start. Saving the misses too is what makes the per-band
      // percent (known / seen) persist correctly across sessions — the denominator
      // includes the words you've seen-but-don't-know, not just the ones you know.
      void saveDictionaryWord({
        userId,
        word,
        initialStability: didKnow ? KNOWN_WORD_STABILITY : undefined,
      }).catch((e) => console.warn("calibration: save failed", e));
      session.current.push({
        band: word.proficiencyBand,
        difficulty: getDifficulty(word).level,
        confidence: didKnow ? 5 : 0,
      });
      if (didKnow) setKnown((n) => n + 1);
      else setUnknown((n) => n + 1);
      const l = recompute();
      setRevealed(false);
      setIndex((i) => i + 1);
      // Refill around the (possibly shifted) provisional band when the deck runs low.
      if (deck.length - (index + 1) <= DECK_LOW) {
        void refill(l.band > 0 ? l.band : Math.ceil(maxBand.current / 2));
      }
    },
    [deck, index, userId, recompute, refill],
  );

  const addToList = useCallback(
    async (word: Word, listId?: string) => {
      await saveDictionaryWord({ userId, word, listId });
      setTagged((s) => new Set(s).add(word.wordId));
    },
    [userId],
  );

  const finish = useCallback(() => {
    const l = live ?? recompute();
    setStatus("done");
    void setUserProficiencyBand(userId, l.band > 0 ? l.band : null).catch((e) =>
      console.warn("calibration: persist band failed", e),
    );
    void setUserLevel(userId, l.level).catch((e) => console.warn("calibration: persist level failed", e));
  }, [userId, live, recompute]);

  const framework = proficiencyFrameworkFor(langsRef.current.learning);
  const bandLabel = live && live.band > 0 && framework ? labelForBand(framework, live.band) : null;

  return {
    status,
    error,
    /** The word on screen (undefined while a refill is in flight). */
    current: deck[index] as Word | undefined,
    revealed,
    reveal: () => setRevealed(true),
    /** Swipe/keyboard verdict. */
    rate,
    /** Tag the current word into a sub-list (independent of the swipe). */
    addToList,
    tagged,
    /** Commit the current level and finish. */
    finish,
    /** Retake from scratch. */
    restart: load,
    /** The live vocabulary-based level (perBand / band / sufficient / needMore). */
    live,
    /** Learner-facing label of the provisional/determined band ("N3"), or null. */
    bandLabel,
    known,
    unknown,
  };
}
