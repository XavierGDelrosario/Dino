// App shell. Bootstraps the guest session, then a simple tab nav over the two
// live surfaces wired to the service layer: Translate (look up + save words)
// and Review (flashcards). Lists / paragraph-translate views come next.
import { useState } from "react";
import { useSession } from "./hooks/useSession";
import { TranslateView } from "./views/TranslateView";
import { ListView } from "./views/ListView";
import { FlashcardView } from "./views/FlashcardView";
import "./components/common/common.css";

type Tab = "translate" | "lists" | "review";

export function App() {
  const { userId, loading, error } = useSession();
  const [tab, setTab] = useState<Tab>("translate");
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
      </header>

      {loading && <p className="review__msg">Starting session…</p>}
      {error && (
        <div className="review__msg">
          <p>Couldn’t start a session.</p>
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
              Translate
            </button>
            <button
              className={`tab${tab === "lists" ? " tab--active" : ""}`}
              onClick={() => setTab("lists")}
            >
              Lists
            </button>
            <button
              className={`tab${tab === "review" ? " tab--active" : ""}`}
              onClick={() => setTab("review")}
            >
              Review
            </button>
          </nav>

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
        </>
      )}
    </main>
  );
}
