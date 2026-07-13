// The quiz "flip" preference: which side of a card faces up — the word (default)
// or its meaning. DISPLAY ONLY: it swaps what the front/back show, never what is
// asked of the SRS (the grade still records against the same user_word), and the
// readings stay on the revealed side either way (see FlashcardCard).
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

function read(): boolean {
  try {
    return sessionStorage.getItem(KEY) === "1";
  } catch {
    return false; // private mode / no storage — just default to word-first.
  }
}

function write(reversed: boolean): void {
  try {
    sessionStorage.setItem(KEY, reversed ? "1" : "0");
  } catch {
    /* preference is a nicety; never break the quiz over it */
  }
}

export interface QuizFlip {
  /** What the CURRENT card renders: true = meaning on the front. */
  reversed: boolean;
  /** What the user has selected — takes effect on the next card. */
  pending: boolean;
  /** The toggle is armed but not yet showing (drives the "next card" hint). */
  pendingChange: boolean;
  toggle: () => void;
}

/**
 * @param cardKey changes whenever the quiz moves to another card (pass the 1-based
 *        position). A restart resets it to the first card, which re-applies the
 *        remembered preference.
 */
export function useQuizFlip(cardKey: number): QuizFlip {
  const [pending, setPending] = useState(read);
  // The first card of a session already honors the remembered preference — only
  // toggles made DURING a card are deferred.
  const [applied, setApplied] = useState(pending);

  // Read `pending` without making it an effect dependency: the effect must fire on
  // a card change ONLY, not the moment the user toggles.
  const latest = useRef(pending);
  latest.current = pending;

  useEffect(() => {
    setApplied(latest.current);
  }, [cardKey]);

  const toggle = useCallback(() => {
    setPending((p) => {
      const next = !p;
      write(next);
      return next;
    });
  }, []);

  return { reversed: applied, pending, pendingChange: pending !== applied, toggle };
}
