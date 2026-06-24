// The main app surface: tab nav over the three live views (Translate · Lists ·
// Review). Owns the tab + review-scope state. Lazy-loads each view's chunk.
import { Suspense, lazy, useState } from "react";
import { useI18n } from "../i18n";

const TranslateView = lazy(() =>
  import("./TranslateView").then((m) => ({ default: m.TranslateView })),
);
const ListView = lazy(() => import("./ListView").then((m) => ({ default: m.ListView })));
const FlashcardView = lazy(() =>
  import("./FlashcardView").then((m) => ({ default: m.FlashcardView })),
);

type Tab = "translate" | "lists" | "review";

export function HomeView({ userId }: { userId: string }) {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>("translate");
  // which vocabulary the Review tab quizzes (null = ALL; name "" = the virtual ALL
  // list, which FlashcardView localizes). Set by a list's "Review" button.
  const [reviewScope, setReviewScope] = useState<{ listId: string | null; name: string }>({
    listId: null,
    name: "",
  });

  return (
    <>
      <nav className="tabs">
        <button className={`tab${tab === "translate" ? " tab--active" : ""}`} onClick={() => setTab("translate")}>
          {t("tabs.translate")}
        </button>
        <button className={`tab${tab === "lists" ? " tab--active" : ""}`} onClick={() => setTab("lists")}>
          {t("tabs.lists")}
        </button>
        <button className={`tab${tab === "review" ? " tab--active" : ""}`} onClick={() => setTab("review")}>
          {t("tabs.review")}
        </button>
      </nav>

      {/* key on userId so a sign-in/out/upgrade-to-different-uid fully resets each
          view's hooks instead of showing the previous user's data. */}
      <Suspense fallback={<p className="review__msg">{t("common.loading")}</p>}>
        {tab === "translate" && <TranslateView key={userId} userId={userId} />}
        {tab === "lists" && (
          <ListView
            key={userId}
            userId={userId}
            onReview={(listId, name) => {
              setReviewScope({ listId, name });
              setTab("review");
            }}
          />
        )}
        {tab === "review" && (
          <FlashcardView
            key={userId}
            userId={userId}
            listId={reviewScope.listId}
            listName={reviewScope.name}
          />
        )}
      </Suspense>
    </>
  );
}
