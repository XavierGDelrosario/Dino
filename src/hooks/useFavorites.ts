// Starred media articles (the ★ list). Owns the loaded set plus the URL index the
// browse list checks to draw each headline's star, and toggles a star optimistically
// — the star is a one-tap gesture over a random feed, so waiting on a round-trip to
// redraw it feels broken; a failed write rolls the row back and surfaces the error.
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  listFavorites,
  addFavorite,
  removeFavorite,
  type Favorite,
} from "../services/media/favorites";
import type { Headline, WikiSite } from "../services/media/mediawiki";
import { errorMessage } from "../lib/errorMessage";

export function useFavorites(userId: string, site: WikiSite = "wikinews", lang = "JA") {
  const [items, setItems] = useState<Favorite[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** URL currently being starred/un-starred, so its button can disable itself. */
  const [pending, setPending] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      setItems(await listFavorites(userId));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [userId]);

  // Load once per user (a user switch resets the view via App's key, but the hook
  // still re-runs on the new id).
  useEffect(() => {
    void reload();
  }, [reload]);

  const urls = useMemo(() => new Set((items ?? []).map((f) => f.url)), [items]);

  /** Star ⇄ un-star. Optimistic; rolls back and reports on failure. */
  const toggle = useCallback(
    async (headline: Headline) => {
      const starred = urls.has(headline.url);
      const before = items ?? [];
      setError(null);
      setPending(headline.url);
      // Optimistic row carries a placeholder id — replaced by the server row below.
      setItems(
        starred
          ? before.filter((f) => f.url !== headline.url)
          : [
              {
                favoriteId: `pending:${headline.url}`,
                title: headline.title,
                summary: headline.summary,
                url: headline.url,
                site,
                lang,
                createdAt: new Date().toISOString(),
              },
              ...before,
            ],
      );
      try {
        if (starred) {
          await removeFavorite({ userId, url: headline.url });
        } else {
          const saved = await addFavorite({ userId, headline, site, lang });
          setItems((cur) =>
            (cur ?? []).map((f) => (f.url === saved.url ? saved : f)),
          );
        }
      } catch (e) {
        setItems(before); // roll back the optimistic change
        setError(errorMessage(e));
      } finally {
        setPending(null);
      }
    },
    [items, urls, userId, site, lang],
  );

  return { items, urls, loading, error, pending, toggle, reload };
}
