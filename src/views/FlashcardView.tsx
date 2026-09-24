// Review session screen: reveal → rate confidence → next, over the N
// least-confident words. The grade is a 1–5 self-rated recall confidence
// (1 = forgot … 5 = easy); clicking a rating records it and advances.
import { useCallback, useEffect, useState } from "react";
import { useReview } from "../hooks/useReview";
import { useQuizFlip } from "../hooks/useQuizFlip";
import { FlashcardCard } from "../components/flashcards/FlashcardCard";
import { QuizExample } from "../components/flashcards/QuizExample";
import { ReportFlagButton } from "../components/common/ReportFlagButton";
import { useSwipeCard } from "../components/flashcards/useSwipeCard";
import { FlipButton } from "../components/flashcards/FlipButton";
import { ProgressBar } from "../components/flashcards/ProgressBar";
import { GradeBar } from "../components/flashcards/GradeBar";
import { QuizWordList } from "../components/flashcards/QuizWordList";
import { softenConfidence } from "../services/review";
import { createList, listUserLists, type List } from "../services/lists";
import { addUserWordToList } from "../services/words/userWords";
import { useI18n } from "../i18n";
import { ErrorText } from "../components/common/ErrorText";
import "../components/flashcards/flashcards.css";
import { Loading } from "../components/common/Loading";

export function FlashcardView({
  userId,
  listId = null,
  listName,
  userWordIds,
  limit,
}: {
  userId: string;
  listId?: string | null;
  listName?: string;
  /** When set, quiz exactly these words (the Lists view's filtered subset). */
  userWordIds?: string[];
  /** Hard cap on the session size (a sub-list "Review" passes 20). Undefined =
   *  the hook's own default/subset ceiling. */
  limit?: number;
}) {
  const r = useReview(userId, listId, limit, userWordIds);

  // The done screen's ＋ files a word into a list, so it needs the user's lists. Review
  // is handed none (it is a tab of its own), so it loads them when a session finishes —
  // after a session in which a list may have been made elsewhere, and only then.
  const [lists, setLists] = useState<List[]>([]);
  useEffect(() => {
    if (r.status !== "done") return;
    let active = true;
    listUserLists(userId)
      .then((ls) => active && setLists(ls))
      .catch((e) => console.warn("FlashcardView: failed to load lists", e));
    return () => {
      active = false;
    };
  }, [r.status, userId]);
  // Deferred to the card boundary — toggling never rewrites the card in front of the
  // user (r.position is the boundary; a restart resets it to 1).
  const flip = useQuizFlip(r.position);

  // Swipe to grade WITHOUT revealing: right = 5 (knew it outright), left = 1 (no
  // idea). Same directions as the placement quiz, so the gesture means one thing
  // everywhere. Only while the card is face-down — once it's revealed the 1–5
  // GradeBar is the affordance, and a swipe there would silently pick 1 or 5 for a
  // user who was reaching for a 3.
  // Swipe UP reveals the meaning — the same as tapping the card.
  const { grade, flip: reveal } = r;
  const swipe = useSwipeCard({
    onLeft: useCallback(() => grade(1), [grade]),
    onRight: useCallback(() => grade(5), [grade]),
    onUp: reveal,
  });

  const { t } = useI18n();
  const scopeName = listName || t("lists.allWords");

  const scope = <p className="review__scope">{t("review.scope", { name: scopeName })}</p>;

  if (r.status === "loading") {
    return <p className="review__msg"><Loading text={t("review.loading")} /></p>;
  }

  if (r.status === "error") {
    return (
      <div className="review__msg">
        <p>{t("review.errorTitle")}</p>
        <ErrorText message={r.error} />
        <button className="btn" onClick={r.restart}>
          {t("common.retry")}
        </button>
      </div>
    );
  }

  if (r.status === "empty") {
    return (
      <div className="review__msg">
        {scope}
        <p>{listId ? t("review.emptyList") : t("review.emptyAll")}</p>
      </div>
    );
  }

  if (r.status === "done") {
    return (
      <div className="review__msg">
        <div className="review__actions">
          <button className="btn" onClick={r.retry}>
            {t("review.retrySame")}
          </button>
          <button className="btn btn--primary" onClick={r.newQuiz}>
            {t("review.newQuiz")}
          </button>
        </div>
        <QuizWordList
          items={r.cards.map((c) => ({
            key: c.userWordId,
            word: c,
            userWordId: c.userWordId,
            confidence: r.gradedConfidence.get(c.userWordId) ?? c.confidenceRating,
            // The queue's own value, i.e. before this session. A card that was never
            // graded falls back to it above too, so the two match and nothing is marked.
            previousConfidence: c.confidenceRating,
          }))}
          onForgot={async (item) =>
            (await softenConfidence({ userWordId: item.userWordId! })).confidenceRating
          }
          lists={lists}
          onTag={(item, id) => addUserWordToList({ userWordId: item.userWordId!, listId: id })}
          onCreateList={async (name) => {
            const list = await createList({ userId, listName: name });
            setLists((ls) => [...ls, list]);
            return list.listId;
          }}
        />
      </div>
    );
  }

  const card = r.current!;
  return (
    <section className="review">
      <div className="review__head">
        {scope}
        <FlipButton flip={flip} />
      </div>
      <ProgressBar position={r.position} total={r.total} />

      {/* Swipe props only while face-down (see the hook call above); revealed, the
          card is static and graded from the bar below. */}
      <div {...(r.flipped || r.submitting ? {} : swipe.props)}>
        <div className="swipecard__in" key={card.userWordId}>
          <FlashcardCard
            word={card}
            flipped={r.flipped}
            onFlip={r.flip}
            reversed={flip.reversed}
            // Same slot as the text/level quiz — a change to "the flashcard quiz"
            // applies to every flashcard surface.
            flag={<ReportFlagButton input={card.input} wordId={card.dictionaryWordId} size={15} />}
          />
        </div>
      </div>

      {/* "Show example" — same disclosure as the text/level quiz. Keyed on the card so
          it re-collapses on every card. */}
      <QuizExample key={card.userWordId} word={card} flipped={r.flipped} />

      <ErrorText message={r.error} />

      <GradeBar flipped={r.flipped} submitting={r.submitting} onReveal={r.flip} onGrade={r.grade} />
    </section>
  );
}
