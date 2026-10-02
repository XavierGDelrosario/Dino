// Quiz session over the words in a pasted text, reveal → rate → next. Two modes:
//   · learn  — the NEW words; each rating ADDS the word + records a first review.
//   · review — words ALREADY saved; each rating just records a review (in-context
//              SRS practice). saveDictionaryWord is idempotent, so useTextQuiz
//              handles both with the same save-then-record path.
// Reuses the flashcard card/progress/grade UI from the review surface.
import { useCallback } from "react";
import { useTextQuiz, type OnGraded } from "../hooks/useTextQuiz";
import { useQuizFlip } from "../hooks/useQuizFlip";
import { type WordContext } from "../services/analyze/context";
import { FlashcardCard } from "../components/flashcards/FlashcardCard";
import { ReportFlagButton } from "../components/common/ReportFlagButton";
import { useSwipeCard } from "../components/flashcards/useSwipeCard";
import { FlipButton } from "../components/flashcards/FlipButton";
import { ProgressBar } from "../components/flashcards/ProgressBar";
import { GradeBar } from "../components/flashcards/GradeBar";
import { QuizWordList } from "../components/flashcards/QuizWordList";
import { QuizHints } from "../components/flashcards/QuizHints";
import { softenConfidence } from "../services/review";
import { addUserWordToList } from "../services/words/userWords";
import { AddToListButton } from "../components/translate/AddToListButton";
import { ErrorText } from "../components/common/ErrorText";
import { Loading } from "../components/common/Loading";
import { SaveFailures } from "../components/flashcards/SaveFailures";
import { useI18n } from "../i18n";
import type { Word } from "../services/words/repository";
import type { List } from "../services/lists";
import "../components/flashcards/flashcards.css";

export type QuizMode = "learn" | "review";
/** Where a session's cards came from. Affects COPY only — the loop is identical. */
export type QuizSource = "text" | "level";

// A common word can appear in a dozen sentences; the panel is a memory jog, not a
// concordance, so show the first few and let the reader supply the rest.
const MAX_CONTEXT_SENTENCES = 3;

export function TextQuizView({
  userId,
  cards,
  lists,
  mode = "learn",
  onGraded,
  onCreateList,
  onClose,
  onNewQuiz,
  context,
  source = "text",
}: {
  userId: string;
  /** One entry per word — its full sense list (primary first) so meanings cycle. */
  cards: Word[][];
  /** Source sentences per word (by primary-sense wordId) for the "Show in context"
      reveal. Omitted by surfaces with no source text (the level-based Learn quiz),
      which simply hides the button. */
  context?: Map<string, WordContext[]>;
  /** The user's sub-lists, for the add-to-list menu. */
  lists: List[];
  mode?: QuizMode;
  /** WHERE the cards came from — it only changes the copy. The default wording says
   *  "this text", which is true for the reader and an article but a lie on the Learn
   *  tab, whose cards are drawn from a proficiency BAND and never came from a passage
   *  the user can see. */
  source?: QuizSource;
  /** Sync the reader's saved/confidence state as each word is learned/reviewed. */
  onGraded?: OnGraded;
  /** Create a sub-list, returning its id (then the word is tagged into it). */
  onCreateList: (name: string) => Promise<string>;
  /** Return to the reader. */
  onClose: () => void;
  /** Start a FRESH quiz (a new batch of words). When set, the done screen shows a
      "New quiz" button — used by the level-based Learn flow to pull the next unseen
      batch at the same band. Omitted by the reader (its words are a fixed text). */
  onNewQuiz?: () => void;
}) {
  // mode "learn" = NEW words (first-encounter recall), the right signal to
  // calibrate the user's level on — done silently in the hook (no UI here).
  const q = useTextQuiz(userId, cards, { onGraded, calibrate: mode === "learn" });
  // Keyed on the card position, NOT the shown sense — cycling meanings mid-card must
  // not be treated as a card boundary (it would flip the card under the user).
  const flip = useQuizFlip(q.position);

  // Swipe to grade a FACE-DOWN card: right = 5, left = 1 (same directions as Review
  // and the placement quiz). Revealed, the card's own swipe cycles meanings instead
  // — the two never both apply, because this wrapper's handlers are only attached
  // while `!q.flipped` and the card's own only while `q.flipped`.
  // Swipe UP reveals the meaning — the same as tapping the card.
  const { grade, flip: reveal } = q;
  const swipe = useSwipeCard({
    onLeft: useCallback(() => grade(1), [grade]),
    onRight: useCallback(() => grade(5), [grade]),
    onUp: reveal,
  });

  const { t } = useI18n();

  // Keyed on the card's PRIMARY sense — how a card is identified everywhere else
  // (addableCards / the article word list both build a card from senses[0]).
  const sentences = (context?.get(q.senses[0]?.wordId ?? "") ?? []).slice(0, MAX_CONTEXT_SENTENCES);

  const close = (
    <button className="btn btn--ghost" onClick={onClose}>
      {t(source === "level" ? "quiz.backLevel" : "quiz.back")}
    </button>
  );

  if (q.status === "empty") {
    return (
      <div className="review__msg">
        <p>
          {mode === "review"
            ? t("quiz.emptyReview")
            : t(source === "level" ? "quiz.emptyLearnLevel" : "quiz.emptyLearn")}
        </p>
        {close}
      </div>
    );
  }

  // The last card was graded; its write (and any still in flight) is landing.
  if (q.status === "saving") {
    return <p className="review__msg"><Loading text={t("quiz.saving")} /></p>;
  }

  if (q.status === "done") {
    return (
      <div className="review__msg">
        <SaveFailures count={q.failed.length} error={q.error} onRetry={q.retryFailed} />
        <div className="review__foot">
          <button className="btn quiz__donebtn" onClick={q.restart}>
            {t("quiz.again")}
          </button>
          {onNewQuiz && (
            <button className="btn btn--primary quiz__donebtn" onClick={onNewQuiz}>
              {t("review.newQuiz")}
            </button>
          )}
          {close}
        </div>
        <QuizWordList
          items={q.graded.map((g) => ({
            key: g.word.wordId,
            word: g.word,
            userWordId: g.userWordId,
            confidence: g.confidence,
            previousConfidence: g.previousConfidence,
          }))}
          onForgot={async (item) => {
            const res = await softenConfidence({ userWordId: item.userWordId! });
            // Keep the reader behind this quiz in step, as a grade does.
            onGraded?.(item.key, res.userWordId, res.confidenceRating);
            return res.confidenceRating;
          }}
          lists={lists}
          onTag={(item, id) => addUserWordToList({ userWordId: item.userWordId!, listId: id })}
          onCreateList={onCreateList}
        />
      </div>
    );
  }

  const card = q.current!;
  return (
    <section className="review">
      <div className="review__head">
        <p className="review__scope">
          {mode === "review"
            ? t("quiz.scopeReview")
            : t(source === "level" ? "quiz.scopeLearnLevel" : "quiz.scopeLearn")}
        </p>
        <FlipButton flip={flip} />
      </div>
      <ProgressBar position={q.position} total={q.total} />

      {/* The card + a top-right ＋ add-to-list button (adds the SELECTED meaning,
          which defaults to the first, and — via the shared menu — can file it into
          a sub-list or a newly-created one) and ←/→ meaning-cycle arrows when the
          word has more than one sense. Keyed on the sense so cycling the meaning
          resets the button to add the newly-shown one. */}
      <div {...(q.flipped || q.locked ? {} : swipe.props)}>
      <div className={`quizcard${q.advancing ? " flashcard--gap" : ""}`}>
        <FlashcardCard
          word={card}
          flipped={q.flipped}
          onFlip={q.flip}
          reversed={flip.reversed}
          // Top-right of the card, beside the ＋. Reports the exact SENSE being shown — the meaning
          // is what a quiz card is about, so a wrong one is the likeliest thing to flag.
          flag={<ReportFlagButton input={card.input} wordId={card.wordId} size={15} />}
          // Swipe to cycle meanings — same gate as the arrows (revealed + >1 sense).
          // Left = next, right = previous.
          onSwipeLeft={q.hasMultipleMeanings && q.flipped ? q.nextMeaning : undefined}
          onSwipeRight={q.hasMultipleMeanings && q.flipped ? q.prevMeaning : undefined}
          // ＋ add-to-list INSIDE the card's top-right (adds the selected meaning).
          action={
            <AddToListButton
              key={card.wordId}
              className={`card-add${q.isCurrentSaved ? " is-saved" : ""}`}
              words={[card]}
              lists={lists}
              label={q.isCurrentSaved ? "✓" : "＋"}
              alreadyAdded={q.isCurrentSaved}
              onAdd={(words, listId) => q.addWord(words[0], listId)}
              onCreateList={onCreateList}
            />
          }
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
      </div>

      {/* "Show in context" + "Show example" — one row of toggles, one panel open at a
          time. Keyed on the position so it re-collapses on every card. */}
      <QuizHints key={`hints-${q.position}`} word={card} flipped={q.flipped} context={sentences} />

      <ErrorText message={q.error} />

      <GradeBar flipped={q.flipped} submitting={q.locked} onReveal={q.flip} onGrade={q.grade} />

      <div className="review__foot">{close}</div>
    </section>
  );
}
