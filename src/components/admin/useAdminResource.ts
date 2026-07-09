// The fetch-with-loading/error scaffolding every admin panel repeated: a nullable
// data slot, a nullable error string, an unmount cancel-guard, and errorMessage()
// mapping. `reload()` re-runs the fetch (after a mutation, or a Refresh button).
// Pass `deps` for inputs the fetcher closes over (filters) so it refetches on change;
// pass `resetOnReload` to blank the data (show "Loading…") while refetching.
import { useCallback, useEffect, useRef, useState, type DependencyList } from "react";
import { errorMessage } from "../../lib/errorMessage";

export function useAdminResource<T>(
  fetcher: () => Promise<T>,
  deps: DependencyList = [],
  { resetOnReload = false }: { resetOnReload?: boolean } = {},
): { data: T | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const active = useRef(true);

  const reload = useCallback(() => {
    if (resetOnReload) setData(null);
    setError(null);
    fetcher()
      .then((d) => active.current && setData(d))
      .catch((e) => active.current && setError(errorMessage(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    active.current = true;
    reload();
    return () => {
      active.current = false;
    };
  }, [reload]);

  return { data, error, reload };
}
