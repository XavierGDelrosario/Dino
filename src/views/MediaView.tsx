// Media surface — study a real language from the news. Browses **Wikinews in the
// language you're LEARNING** (ja.wikinews ≈ 4k articles, en.wikinews ≈ 22k): a batch
// of random headlines with a Refresh for a fresh batch. Wikinews' API is CORS-open
// and its text is CC BY 2.5, so — unlike a gated news SPA — we can show the real
// prose. "Study" opens the in-depth analysis (ArticleView), which also hosts the
// reading mode — the whole Study → analyze → read → back loop stays in this tab.
//
// This surface is EMBEDDED in Learn (below its band buttons), not a tab and not a
// takeover, so it owns no language of its own: the corpus + the analysis pair arrive
// as `langs` from the host's picker. ArticleView analyzes through useTranslate, which
// reads the SOURCE off that pair, so a corpus that ignored it would hand the reader
// (say) English prose to segment as Japanese. It tells the host when an article opens
// (`onArticleOpen`) so the host can fold its own chrome away and let the analysis have
// the tab.
//
// Every Wikinews edition went read-only in May 2026 (the WMF closed the project), so
// each is a fixed archive rather than a live feed — which is what the tab already
// assumed: random browse over a corpus, not a news ticker.
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
import { type LangCode } from "../services/language";
import { FavoriteStar } from "../components/media/FavoriteStar";
import { ArticleView } from "./ArticleView";
import { ErrorText } from "../components/common/ErrorText";
import { errorMessage } from "../lib/errorMessage";
import { useI18n, type MessageKey } from "../i18n";
import "./media.css";

const SITE: WikiSite = "wikinews";

/** Learning language → its LOCALIZED name, for the intro line ("Study real X…"). */
const LANG_NAME: Record<string, MessageKey> = { JA: "lang.JA", EN: "lang.EN" };

type Tab = "browse" | "favorites";

export function MediaView({
  userId,
  langs,
  ready,
  onArticleOpen,
}: {
  userId: string;
  /**
   * The pair the corpus is browsed in and the ARTICLE is analyzed in — the host's
   * picker, passed down rather than duplicated here. `learning` picks the wiki;
   * `native` is what the article is explained in, already collapsed-pair-safe by the
   * host (LearnView's `explainIn`).
   */
  langs: { learning: LangCode; native: LangCode };
  /** False while the host is still reading the profile — see the load guard below. */
  ready: boolean;
  /** Told when the article analysis opens/closes, so the host can hide its chrome. */
  onArticleOpen?: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const lang = langs.learning;
  const [tab, setTab] = useState<Tab>("browse");
  const [items, setItems] = useState<Headline[] | null>(null);
  // Starts LOADING, not idle: the first fetch waits for the profile to say which
  // wiki to read, and an idle-but-empty first paint reads as "no articles".
  const [loading, setLoading] = useState(true);
  const [loadingUrl, setLoadingUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The selected article → its in-depth summary page (replaces the browse list).
  const [article, setArticle] = useState<Article | null>(null);
  // The HEADLINE the open article came from. `Article` carries no summary, but a
  // saved article stores one (it's what the ★ Saved list renders), so keep the
  // headline that produced it rather than reconstructing a lossy summary from the
  // body text.
  const [openedFrom, setOpenedFrom] = useState<Headline | null>(null);
  const favorites = useFavorites(userId, SITE, lang);

  const load = useCallback(async () => {
    // Nothing to browse until the profile says which wiki this is. `ready` is set
    // on a FAILED profile read too, so an unreachable profile falls back to the
    // default language instead of leaving the tab spinning forever.
    if (!ready) return;
    setError(null);
    setLoading(true);
    try {
      setItems(await randomHeadlines({ site: SITE, lang, limit: 12 }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [lang, ready]);

  // Re-runs when the learning language resolves or changes — a new corpus needs a
  // new batch, and the old one's headlines aren't studiable in the new direction.
  useEffect(() => {
    void load();
  }, [load]);

  // The language now changes from OUTSIDE (the host's picker), so the close-what's-open
  // that used to live in the local picker's onChange has to be an effect: an article is
  // only studiable in the direction it was opened in.
  useEffect(() => {
    setArticle(null);
    setOpenedFrom(null);
    setTab("browse");
  }, [lang]);

  // Report the takeover rather than letting the host guess: the analysis renders in
  // this component's slot, so the host has to fold its own chrome away for it.
  useEffect(() => {
    onArticleOpen?.(article !== null);
  }, [article, onArticleOpen]);

  // Fetch the full article, then open its in-depth summary page. Keyed on the URL
  // (not the title) so the spinner lands on the row that was clicked even when the
  // same story is showing in both lists.
  const study = async (h: Headline) => {
    setError(null);
    setLoadingUrl(h.url);
    try {
      const fetched = await fetchArticle({ site: SITE, lang, title: h.title });
      if (!fetched.text.trim()) {
        setError(t("media.empty"));
        return;
      }
      setArticle(fetched);
      setOpenedFrom(h);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoadingUrl(null);
    }
  };

  // The summary page takes over the tab, and its own reading mode takes over from
  // there — so Study → analysis → read → back all stay inside Media.
  if (article) {
    return (
      <ArticleView
        userId={userId}
        article={article}
        // The article's OWN language, not the profile's — Media can browse a corpus
        // you aren't studying, and an English article analyzed as Japanese resolves
        // nothing (and, when EN is also your native language, echoes instead).
        langs={langs}
        onBack={() => setArticle(null)}
        // The star is driven from THIS hook instance, not a second one inside
        // ArticleView: MediaView stays mounted behind the analysis, so a star
        // toggled in there is already reflected when you come back. A second
        // useFavorites would be an independent copy that silently diverges.
        favorite={
          openedFrom
            ? {
                starred: favorites.urls.has(openedFrom.url),
                pending: favorites.pending === openedFrom.url,
                onToggle: () => void favorites.toggle(openedFrom),
              }
            : undefined
        }
      />
    );
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
          <FavoriteStar
            starred={starred}
            pending={favorites.pending === a.url}
            onToggle={() => void favorites.toggle(a)}
          />
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
      {/* No language picker and no back button: this is embedded in Learn, which owns
          both — one picker for the tab, and the way out is the tab itself. */}
      <div className="media__head">
        <p className="review__scope">{t("media.intro", { lang: t(LANG_NAME[lang] ?? "lang.JA") })}</p>
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
