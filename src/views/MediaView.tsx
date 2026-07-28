// Media surface — study real Japanese from the news. Browses **Japanese Wikinews**
// (a ~4k-article archive; no new stories, which is fine as a study corpus): a batch
// of random headlines with a Refresh for a fresh batch. Wikinews' API is CORS-open
// and its text is CC BY 2.5, so — unlike a gated news SPA — we can show the real
// prose. "Study" opens the in-depth analysis (ArticleView), which also hosts the
// reading mode — the whole Study → analyze → read → back loop stays in this tab.
import { useCallback, useEffect, useState } from "react";
import {
  randomHeadlines,
  fetchArticle,
  type Headline,
  type Article,
} from "../services/media/mediawiki";
import { ArticleView } from "./ArticleView";
import { ErrorText } from "../components/common/ErrorText";
import { errorMessage } from "../lib/errorMessage";
import { useI18n } from "../i18n";
import "./media.css";

export function MediaView({ userId }: { userId: string }) {
  const { t } = useI18n();
  const [items, setItems] = useState<Headline[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingTitle, setLoadingTitle] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The selected article → its in-depth summary page (replaces the browse list).
  const [article, setArticle] = useState<Article | null>(null);

  const load = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      setItems(await randomHeadlines({ limit: 12 }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Fetch the full article, then open its in-depth summary page.
  const study = async (title: string) => {
    setError(null);
    setLoadingTitle(title);
    try {
      const fetched = await fetchArticle({ title });
      if (!fetched.text.trim()) {
        setError(t("media.empty"));
        return;
      }
      setArticle(fetched);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoadingTitle(null);
    }
  };

  // The summary page takes over the tab, and its own reading mode takes over from
  // there — so Study → analysis → read → back all stay inside Media.
  if (article) {
    return <ArticleView userId={userId} article={article} onBack={() => setArticle(null)} />;
  }

  return (
    <section className="review media">
      <div className="media__head">
        <p className="review__scope">{t("media.intro")}</p>
        <button className="btn btn--sm" type="button" onClick={() => void load()} disabled={loading}>
          {loading ? "…" : t("media.refresh")}
        </button>
      </div>

      <ErrorText message={error} />

      {!items && loading ? (
        <p className="review__msg">{t("media.loading")}</p>
      ) : (
        <ul className="media__list">
          {items?.map((a) => (
            <li key={a.url} className="media__item">
              <h3 className="media__title">{a.title}</h3>
              {a.summary && <p className="media__summary">{a.summary}</p>}
              <div className="media__actions">
                <button
                  className="btn btn--primary"
                  onClick={() => void study(a.title)}
                  disabled={loadingTitle !== null}
                >
                  {loadingTitle === a.title ? t("media.loadingArticle") : t("media.study")}
                </button>
                <a className="btn btn--ghost" href={a.url} target="_blank" rel="noopener noreferrer">
                  {t("media.readOnWikinews")} ↗
                </a>
              </div>
            </li>
          ))}
        </ul>
      )}

      {items && items.length > 0 && <p className="media__attribution">{t("media.source")}</p>}
    </section>
  );
}
