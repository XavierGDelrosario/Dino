// Quiz session over the words in a pasted text, reveal → rate → next. Two modes:
//   · learn  — the NEW words; each rating ADDS the word + records a first review.
//   · review — words ALREADY saved; each rating just records a review (in-context
//              SRS practice). saveDictionaryWord is idempotent, so useTextQuiz
//              handles both with the same save-then-record path.
// Reuses the flashcard card/progress/grade UI from the review surface.
import { useTextQuiz, type OnGraded } from "../hooks/useTextQuiz";
import { FlashcardCard } from "../components/flashcards/FlashcardCard";
import { ProgressBar } from "../components/flashcards/ProgressBar";
import { GradeBar } from "../components/flashcards/GradeBar";
import { AddToListButton } from "../components/translate/AddToListButton";
import { ErrorText } from "../components/common/ErrorText";
import { useI18n, plural } from "../i18n";
import type { Word } from "../services/words/repository";
import type { List } from "../services/lists";
import "../components/flashcards/flashcards.css";

export type QuizMode = "learn" | "review";

export function TextQuizView({
  userId,
  cards,
  lists,
  mode = "learn",
  onGraded,
  onCreateList,
  onClose,
}: {
  userId: string;
  /** One entry per word — its full sense list (primary first) so meanings cycle. */
  cards: Word[][];
  /** The user's sub-lists, for the add-to-list menu. */
  lists: List[];
  mode?: QuizMode;
  /** Sync the reader's saved/confidence state as each word is learned/reviewed. */
  onGraded?: OnGraded;
  /** Create a sub-list, returning its id (then the word is tagged into it). */
  onCreateList: (name: string) => Promise<string>;
  /** Return to the reader. */
  onClose: () => void;
}) {
  // mode "learn" = NEW words (first-encounter recall), the right signal to
  // calibrate the user's level on — done silently in the hook (no UI here).
  const q = useTextQuiz(userId, cards, { onGraded, calibrate: mode === "learn" });
  const { t } = useI18n();
  const noun = (n: number) => plural(t, n, "common.word", "common.words");

  const close = (
    <button className="btn btn--ghost" onClick={onClose}>
      {t("quiz.back")}
    </button>
  );

  if (q.status === "empty") {
    return (
      <div className="review__msg">
        <p>{mode === "review" ? t("quiz.emptyReview") : t("quiz.emptyLearn")}</p>
        {close}
      </div>
    );
  }

  if (q.status === "done") {
    return (
      <div className="review__msg">
        <p>
          {mode === "review"
            ? t("quiz.doneReview", { n: q.reviewedCount, noun: noun(q.reviewedCount) })
            : t("quiz.doneLearn", { n: q.reviewedCount, noun: noun(q.reviewedCount) })}
        </p>
        <div className="review__foot">
          <button className="btn" onClick={q.restart}>
            {t("quiz.again")}
          </button>
          {close}
        </div>
      </div>
    );
  }

  const card = q.current!;
  return (
    <section className="review">
      <p className="review__scope">
        {mode === "review" ? t("quiz.scopeReview") : t("quiz.scopeLearn")}
      </p>
      <ProgressBar position={q.position} total={q.total} />

      {/* The card + a top-right ＋ add-to-list button (adds the SELECTED meaning,
          which defaults to the first, and — via the shared menu — can file it into
          a sub-list or a newly-created one) and ←/→ meaning-cycle arrows when the
          word has more than one sense. Keyed on the sense so cycling the meaning
          resets the button to add the newly-shown one. */}
      <div className="quizcard">
        <AddToListButton
          key={card.wordId}
          className={`quizcard__add${q.isCurrentSaved ? " is-saved" : ""}`}
          words={[card]}
          lists={lists}
          label={q.isCurrentSaved ? "✓" : "＋"}
          alreadyAdded={q.isCurrentSaved}
          onAdd={(words, listId) => q.addWord(words[0], listId)}
          onCreateList={onCreateList}
        />

        <FlashcardCard
          word={card}
          flipped={q.flipped}
          onFlip={q.flip}
          // Swipe to cycle meanings — same gate as the arrows (revealed + >1 sense).
          // Left = next, right = previous.
          onSwipeLeft={q.hasMultipleMeanings && q.flipped ? q.nextMeaning : undefined}
          onSwipeRight={q.hasMultipleMeanings && q.flipped ? q.prevMeaning : undefined}
        />

        {/* Meaning-cycle arrows appear only once the meaning is REVEALED — before
            that the card is a recall test, so cycling senses would spoil it. */}
        {q.hasMultipleMeanings && q.flipped && (
          <div className="quizcard__meaningnav">
            <button
              className="quizcard__arrow"
              onClick={q.prevMeaning}
              aria-label={t("quiz.prevMeaning")}
            >
              ‹
            </button>
            <span className="quizcard__meaningpos">
              {t("quiz.meaningPos", { i: q.meaningIndex + 1, n: q.senses.length })}
            </span>
            <button
              className="quizcard__arrow"
              onClick={q.nextMeaning}
              aria-label={t("quiz.nextMeaning")}
            >
              ›
            </button>
          </div>
        )}
      </div>

      <ErrorText message={q.error} />

      <GradeBar flipped={q.flipped} submitting={q.submitting} onReveal={q.flip} onGrade={q.grade} />

      <div className="review__foot">{close}</div>
    </section>
  );
}
