// The quiz "flip" preference: which side of a card faces up — the word (default),
// its meaning, or RANDOM (a fresh coin toss per card, so you're drilled both ways in
// one session). The button cycles word → meaning → random → word. DISPLAY ONLY: it swaps what the front/back show, never what is
// asked of the SRS (the grade still records against the same user_word and moves the
// same one schedule), and the readings stay on the revealed side either way (see
// FlashcardCard). The views do pass `reversed` along with each grade so review_log
// records which way the card faced (migration 20260784) — logged, never scheduled on.
//
// Two pieces of state on purpose. `pending` is what the user has toggled; `applied`
// is what the CURRENT card renders. Toggling mid-card must not rewrite the card the
// user is already looking at (that would flash the answer they're trying to recall),
// so `pending` only lands on `applied` when the card advances — the views pass their
// card position as `cardKey`. The gap between the two is what the button surfaces as
// "next card" feedback.
//
// Remembered for the SESSION (sessionStorage): it survives leaving a quiz and
// starting another one in the same app run, and resets on a fresh launch — no DB
// column, no user setting to migrate.
import { useCallback, useEffect, useRef, useState } from "react";

const KEY = "dino.quiz.reversed";

/** Which face is up: the word, its meaning, or a coin toss per card. */
export type FlipMode = "word" | "meaning" | "random";

const CYCLE: Record<FlipMode, FlipMode> = { word: "meaning", meaning: "random", random: "word" };
/** Stored as "0"/"1" (the pre-random values, still read) or "r". */
const STORED: Record<FlipMode, string> = { word: "0", meaning: "1", random: "r" };

function read(): FlipMode {
  try {
    const v = sessionStorage.getItem(KEY);
    return v === "1" ? "meaning" : v === "r" ? "random" : "word";
  } catch {
    return "word"; // private mode / no storage — just default to word-first.
  }
}

function write(mode: FlipMode): void {
  try {
    sessionStorage.setItem(KEY, STORED[mode]);
  } catch {
    /* preference is a nicety; never break the quiz over it */
  }
}

/** Whether a card shown under `mode` has its meaning on the front. */
function faceFor(mode: FlipMode): boolean {
  return mode === "meaning" || (mode === "random" && Math.random() < 0.5);
}

export interface QuizFlip {
  /** What the CURRENT card renders: true = meaning on the front. */
  reversed: boolean;
  /** What the user has selected — takes effect on the next card. */
  pending: FlipMode;
  /** The selection is armed but not yet showing (drives the "next card" hint). */
  pendingChange: boolean;
  /** Advance the selection: word → meaning → random → word. */
  cycle: () => void;
}

/**
 * @param cardKey changes whenever the quiz moves to another card (pass the 1-based
 *        position). A restart resets it to the first card, which re-applies the
 *        remembered preference. Under "random" each new key is a fresh toss.
 */
export function useQuizFlip(cardKey: number): QuizFlip {
  const [pending, setPending] = useState<FlipMode>(read);
  // The first card of a session already honors the remembered preference — only
  // changes made DURING a card are deferred.
  const [applied, setApplied] = useState<FlipMode>(pending);
  const [reversed, setReversed] = useState(() => faceFor(pending));

  // Read `pending` without making it an effect dependency: the effect must fire on
  // a card change ONLY, not the moment the user clicks.
  const latest = useRef(pending);
  latest.current = pending;
  const first = useRef(true);

  useEffect(() => {
    // The mount run would re-toss the first card's random face — it is already set.
    if (first.current) {
      first.current = false;
      return;
    }
    setApplied(latest.current);
    setReversed(faceFor(latest.current));
  }, [cardKey]);

  const cycle = useCallback(() => {
    setPending((p) => {
      const next = CYCLE[p];
      write(next);
      return next;
    });
  }, []);

  return { reversed, pending, pendingChange: pending !== applied, cycle };
}
