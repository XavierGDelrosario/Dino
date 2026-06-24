// App shell. Bootstraps the guest session, then a simple tab nav over the two
// live surfaces wired to the service layer: Translate (look up + save words)
// and Review (flashcards). Lists / paragraph-translate views come next.
import { Suspense, lazy, useEffect, useState } from "react";
import { useSession } from "./hooks/useSession";
import { warmJapaneseAnalyzer } from "./services/language";
import { AttributionFooter } from "./components/common/AttributionFooter";
import { LanguagePicker } from "./components/common/LanguagePicker";
import { useI18n } from "./i18n";
import "./components/common/common.css";

// Each tab's view is its own lazy chunk, so the initial bundle ships only the
// shell + the first surface — the Lists/Review code loads when first opened.
// (Named exports → map to a default for React.lazy.)
const TranslateView = lazy(() =>
  import("./views/TranslateView").then((m) => ({ default: m.TranslateView })),
);
const ListView = lazy(() =>
  import("./views/ListView").then((m) => ({ default: m.ListView })),
);
const FlashcardView = lazy(() =>
  import("./views/FlashcardView").then((m) => ({ default: m.FlashcardView })),
);

type Tab = "translate" | "lists" | "review";

export function App() {
  const { userId, loading, error } = useSession();
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>("translate");

  // Preload kuromoji's dictionary during idle time so the first Japanese analysis
  // (the Translate reader) isn't slowed by the ~12MB load. Best-effort only.
  useEffect(() => {
    const w = window as typeof window & { requestIdleCallback?: (cb: () => void) => void };
    if (w.requestIdleCallback) w.requestIdleCallback(() => warmJapaneseAnalyzer());
    else {
      const t = setTimeout(() => warmJapaneseAnalyzer(), 1500);
      return () => clearTimeout(t);
    }
  }, []);
  // which vocabulary the Review tab quizzes (null = ALL). Set by a list's
  // "Review" button, which also jumps to the Review tab.
  const [reviewScope, setReviewScope] = useState<{ listId: string | null; name: string }>({
    listId: null,
    name: "All words",
  });

  return (
    <main className="app">
      <header className="app__header">
        <h1 className="app__title">DINO 大脳</h1>
        <LanguagePicker />
      </header>

      {loading && <p className="review__msg">{t("app.startingSession")}</p>}
      {error && (
        <div className="review__msg">
          <p>{t("app.sessionErrorTitle")}</p>
          <pre className="review__error">{error.message}</pre>
        </div>
      )}

      {userId && (
        <>
          <nav className="tabs">
            <button
              className={`tab${tab === "translate" ? " tab--active" : ""}`}
              onClick={() => setTab("translate")}
            >
              {t("tabs.translate")}
            </button>
            <button
              className={`tab${tab === "lists" ? " tab--active" : ""}`}
              onClick={() => setTab("lists")}
            >
              {t("tabs.lists")}
            </button>
            <button
              className={`tab${tab === "review" ? " tab--active" : ""}`}
              onClick={() => setTab("review")}
            >
              {t("tabs.review")}
            </button>
          </nav>

          <Suspense fallback={<p className="review__msg">{t("common.loading")}</p>}>
            {tab === "translate" && <TranslateView userId={userId} />}
            {tab === "lists" && (
              <ListView
                userId={userId}
                onReview={(listId, name) => {
                  setReviewScope({ listId, name });
                  setTab("review");
                }}
              />
            )}
            {tab === "review" && (
              <FlashcardView
                userId={userId}
                listId={reviewScope.listId}
                listName={reviewScope.name}
              />
            )}
          </Suspense>
        </>
      )}

      <AttributionFooter />
    </main>
  );
}
