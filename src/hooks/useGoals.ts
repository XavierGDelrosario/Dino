// The user's daily goals (services/goals) for one surface — the /goals page picks
// them, the History plot draws them. Each mount does its own small `users` select (two
// columns; the two pages are never on screen together), so there is no shared store
// here, unlike useStreak. Defaults until the read answers, so a progress line always
// has a denominator.
import { useCallback, useEffect, useState } from "react";
import { DEFAULT_GOALS, getGoals, setGoals as persistGoals, type Goals } from "../services/goals";
import { errorMessage } from "../lib/errorMessage";

export function useGoals(userId: string) {
  const [goals, setGoalsState] = useState<Goals>(DEFAULT_GOALS);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setLoaded(false);
    setError(null);
    getGoals(userId)
      .then((g) => {
        if (!live) return;
        setGoalsState(g);
        setLoaded(true);
      })
      .catch((e) => {
        if (!live) return;
        setError(errorMessage(e));
        setLoaded(true);
      });
    return () => {
      live = false;
    };
  }, [userId]);

  /** Optimistic: the button lights at once; a failed write reports and stays lit. */
  const update = useCallback(
    async (patch: Partial<Goals>) => {
      setGoalsState((g) => ({ ...g, ...patch }));
      try {
        await persistGoals(userId, patch);
      } catch (e) {
        setError(errorMessage(e));
      }
    },
    [userId],
  );

  return { goals, loaded, error, update };
}
