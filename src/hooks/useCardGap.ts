// The beat between one flashcard and the next, shared by every flashcard quiz
// (useReview, useTextQuiz). After a grade the graded card is hidden and the grade bar
// locked for CARD_GAP_MS, so the next word lands on a clean beat and a double-tap can't
// grade two cards. The write itself is NOT waited on — it runs in the background.
import { useCallback, useEffect, useRef, useState } from "react";

export const CARD_GAP_MS = 500;

export function useCardGap(): {
  /** True during the pause — hide the graded card, ignore further grades. */
  advancing: boolean;
  /** Start the pause; `next` (show the next card) runs when it ends. */
  after: (next: () => void) => void;
  /** Abandon a pending pause (a new session started). */
  cancel: () => void;
} {
  const [advancing, setAdvancing] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const cancel = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setAdvancing(false);
  }, []);

  const after = useCallback((next: () => void) => {
    if (timer.current) clearTimeout(timer.current);
    setAdvancing(true);
    timer.current = setTimeout(() => {
      timer.current = null;
      setAdvancing(false);
      next();
    }, CARD_GAP_MS);
  }, []);

  return { advancing, after, cancel };
}
