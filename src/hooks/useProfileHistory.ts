// Loads the profile's History payload once per user (one RPC; see services/history).
// `history` is undefined while loading and NULL when this database can't answer
// (pre-20260775) — the section hides rather than erroring.
import { useEffect, useState } from "react";
import { getProfileHistory, type ProfileHistory } from "../services/history";
import { errorMessage } from "../lib/errorMessage";

export function useProfileHistory(userId: string) {
  const [history, setHistory] = useState<ProfileHistory | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setHistory(undefined);
    setError(null);
    getProfileHistory()
      .then((h) => live && setHistory(h))
      .catch((e) => {
        if (!live) return;
        setError(errorMessage(e));
        setHistory(null);
      });
    return () => {
      live = false;
    };
  }, [userId]);

  return { history, loading: history === undefined, error };
}
