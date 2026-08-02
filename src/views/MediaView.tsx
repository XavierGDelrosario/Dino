// Media surface — study real Japanese from the news. Browses **Japanese Wikinews**
// (a ~4k-article archive; no new stories, which is fine as a study corpus): a batch
// of random headlines with a Refresh for a fresh batch. Wikinews' API is CORS-open
// and its text is CC BY 2.5, so — unlike a gated news SPA — we can show the real
// prose. "Study" opens the in-depth analysis (ArticleView), which also hosts the
// reading mode — the whole Study → analyze → read → back loop stays in this tab.
//
// Two lists behind a toggle: BROWSE (a random batch, gone on Refresh) and
// FAVOURITES (★, kept). Random browse has no back-button, so a story you liked is
// unrecoverable once refreshed away — the star is how a user keeps one. Only the
// pointer is stored (title/url/snippet + the re-fetch coordinates), so opening a
// favourite re-reads the live article; see services/media/favorites.ts.
import { useCallback, useEffect, useState } from "react";
import {
  randomHeadlines,
  fetchArticle,
  type Headline,
  type Article,
  type WikiSite,
} from "../services/media/mediawiki";
import { useFavorites } from "../hooks/useFavorites";
import { ArticleView } from "./ArticleView";
import { ErrorText } from "../components/common/ErrorText";
import { errorMessage } from "../lib/errorMessage";
import { useI18n } from "../i18n";
import "./media.css";

const SITE: WikiSite = "wikinews";
const LANG = "JA";

type Tab = "browse" | "favorites";

export function MediaView({ userId }: { userId: string }) {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>("browse");
  const [items, setItems] = useState<Headline[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingUrl, setLoadingUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The selected article → its in-depth summary page (replaces the browse list).
  const [article, setArticle] = useState<Article | null>(null);
  const favorites = useFavorites(userId, SITE, LANG);

  const load = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      setItems(await randomHeadlines({ site: SITE, lang: LANG, limit: 12 }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Fetch the full article, then open its in-depth summary page. Keyed on the URL
  // (not the title) so the spinner lands on the row that was clicked even when the
  // same story is showing in both lists.
  const study = async (h: Headline) => {
    setError(null);
    setLoadingUrl(h.url);
    try {
      const fetched = await fetchArticle({ site: SITE, lang: LANG, title: h.title });
      if (!fetched.text.trim()) {
        setError(t("media.empty"));
        return;
      }
      setArticle(fetched);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoadingUrl(null);
    }
  };

  // The summary page takes over the tab, and its own reading mode takes over from
  // there — so Study → analysis → read → back all stay inside Media.
  if (article) {
    return <ArticleView userId={userId} article={article} onBack={() => setArticle(null)} />;
  }

  const list: Headline[] | null =
    tab === "browse"
      ? items
      : favorites.items?.map((f) => ({ title: f.title, summary: f.summary, url: f.url })) ?? null;
  const listLoading = tab === "browse" ? loading : favorites.loading;

  const renderItem = (a: Headline) => {
    const starred = favorites.urls.has(a.url);
    return (
      <li key={a.url} className="media__item">
        <div className="media__titleRow">
          <h3 className="media__title">{a.title}</h3>
          <button
            type="button"
            className={`media__star${starred ? " media__star--on" : ""}`}
            aria-pressed={starred}
            title={t(starred ? "media.unfavorite" : "media.favorite")}
            aria-label={t(starred ? "media.unfavorite" : "media.favorite")}
            disabled={favorites.pending === a.url}
            onClick={() => void favorites.toggle(a)}
          >
            {starred ? "★" : "☆"}
          </button>
        </div>
        {a.summary && <p className="media__summary">{a.summary}</p>}
        <div className="media__actions">
          <button
            className="btn btn--primary"
            onClick={() => void study(a)}
            disabled={loadingUrl !== null}
          >
            {loadingUrl === a.url ? t("media.loadingArticle") : t("media.study")}
          </button>
          <a className="btn btn--ghost" href={a.url} target="_blank" rel="noopener noreferrer">
            {t("media.readOnWikinews")} ↗
          </a>
        </div>
      </li>
    );
  };

  return (
    <section className="review media">
      <div className="media__head">
        <p className="review__scope">{t("media.intro")}</p>
        {tab === "browse" && (
          <button className="btn btn--sm" type="button" onClick={() => void load()} disabled={loading}>
            {loading ? "…" : t("media.refresh")}
          </button>
        )}
      </div>

      <div className="media__tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "browse"}
          className={`media__tab${tab === "browse" ? " media__tab--on" : ""}`}
          onClick={() => setTab("browse")}
        >
          {t("media.tabBrowse")}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "favorites"}
          className={`media__tab${tab === "favorites" ? " media__tab--on" : ""}`}
          onClick={() => setTab("favorites")}
        >
          {t("media.tabFavorites", { n: favorites.items?.length ?? 0 })}
        </button>
      </div>

      <ErrorText message={error ?? favorites.error} />

      {!list && listLoading ? (
        <p className="review__msg">{t("media.loading")}</p>
      ) : list && list.length === 0 ? (
        <p className="review__msg">
          {t(tab === "favorites" ? "media.noFavorites" : "media.noArticles")}
        </p>
      ) : (
        <ul className="media__list">{list?.map(renderItem)}</ul>
      )}

      {list && list.length > 0 && <p className="media__attribution">{t("media.source")}</p>}
    </section>
  );
}
