// Google-Translate-style surface:
//   · a language bar (source · ⇄ swap · target) — swap also moves the output
//     into the input and re-translates;
//   · two boxes side by side: input (left, editable) and output (right, the plain
//     translation);
//   · a centered Translate button below;
//   · then the STUDY section: add-to-list / quiz / review controls + the
//     word-by-word reader (hover a word for its meanings).
// Submit is a BUTTON (never Enter — IME safety). A quiz/review session is a FULL
// takeover so nothing can interfere mid-session.
import { useEffect, useState } from "react";
import { useTranslate } from "../hooks/useTranslate";
import { LangBar } from "../components/translate/LangBar";
import { ParagraphReader } from "../components/translate/ParagraphReader";
import { WordResults } from "../components/translate/WordResults";
import { AddToListButton } from "../components/translate/AddToListButton";
import { TextQuizView, type QuizMode } from "./TextQuizView";
import { targetOptions } from "../services/language";
import { useI18n } from "../i18n";
import type { Word } from "../services/words/repository";
import "../components/translate/translate.css";

export function TranslateView({ userId }: { userId: string }) {
  const t = useTranslate(userId);
  const { t: tr } = useI18n();
  const noun = (n: number) => tr(n === 1 ? "common.word" : "common.words");
  const [quiz, setQuiz] = useState<{ words: Word[]; mode: QuizMode } | null>(null);
  const [domainNote, setDomainNote] = useState<string | null>(null);

  // #12 — expand the paragraph into related domain words at the user's level, then
  // quiz them (a learn session, so they're added + feed SRS + refine the level).
  const onExplore = async () => {
    setDomainNote(null);
    const words = await t.exploreDomain();
    if (words.length > 0) setQuiz({ words, mode: "learn" });
    else setDomainNote(tr("translate.noDomain"));
  };

  // Snapshot a paragraph's NEW words ONCE when its result arrives. The live
  // addablePrimaries empties as words get saved, which would otherwise unmount the
  // "Add all" button mid-interaction (so its ✓→+ →menu flow couldn't play out).
  const [addAllWords, setAddAllWords] = useState<Word[]>([]);
  useEffect(() => {
    if (t.status === "done" && t.mode === "paragraph") setAddAllWords(t.addablePrimaries);
    else if (t.status !== "done") setAddAllWords([]);
    // Snapshot only when a fresh result/paragraph arrives — NOT as words save
    // (addablePrimaries is intentionally excluded so the button stays mounted).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t.status, t.mode, t.para]);

  // Quiz/review = full takeover: the entire translate surface is hidden.
  if (quiz) {
    return (
      <section className="translate">
        <TextQuizView
          userId={userId}
          words={quiz.words}
          mode={quiz.mode}
          onGraded={t.applyReview}
          onClose={() => setQuiz(null)}
        />
      </section>
    );
  }

  const wordStudy = t.status === "done" && t.mode === "word" && t.meanings.length > 0;
  const paraStudy = t.status === "done" && t.mode === "paragraph" && t.para;
  const hasActions =
    addAllWords.length > 0 || t.addableCount > 0 || t.reviewableCount > 0 || !!paraStudy;

  return (
    <section className="translate">
      <LangBar
        source={t.source}
        target={t.target}
        onSource={t.setSource}
        onTarget={t.setTarget}
        onSwap={t.swap}
      />

      {/* Two boxes: input (left) | output (right) */}
      <div className="translate__io">
        <textarea
          className="textarea translate__box"
          value={t.input}
          onChange={(e) => t.setInput(e.target.value)}
          placeholder={tr("translate.inputPlaceholder")}
          rows={4}
          aria-label={tr("translate.inputAria")}
        />
        <div className="translate__box translate__out" aria-label={tr("translate.outputAria")}>
          {t.status === "loading" ? (
            <span className="translate__placeholder">{tr("translate.translating")}</span>
          ) : t.output ? (
            t.output
          ) : (
            <span className="translate__placeholder">{tr("translate.outputPlaceholder")}</span>
          )}
        </div>
      </div>

      <div className="translate__submit">
        <button
          className="btn"
          onClick={() => t.submit()}
          disabled={t.status === "loading" || !t.input.trim()}
        >
          {t.status === "loading" ? "…" : tr("translate.submit")}
        </button>
      </div>

      {/* The language you're learning: the study section below always targets it
          (its words get added/quizzed), whether you typed it or it's the output. */}
      <label className="learnpick">
        {tr("translate.learning")}
        <select
          className="select select--sm"
          value={t.learning}
          onChange={(e) => t.setLearning(e.target.value)}
          aria-label={tr("translate.learningAria")}
        >
          {targetOptions().map((o) => (
            <option key={o.code} value={o.code}>
              {o.name}
            </option>
          ))}
        </select>
      </label>

      {t.error && <pre className="review__error">{t.error}</pre>}

      {/* The translation shows above as soon as it's ready; the word-by-word reader
          (kuromoji + lookups) streams in after — spinner while it loads. */}
      {t.mode === "paragraph" && t.readerLoading && !t.para && (
        <p className="reader__loading">{tr("translate.readerLoading")}</p>
      )}

      {/* STUDY section: add/quiz/review controls + the hover-for-meaning reader. */}
      {(wordStudy || paraStudy) && (
        <div className="study">
          {wordStudy && (
            <WordResults
              headword={t.headword}
              meanings={t.meanings}
              saved={t.saved}
              confidence={t.confidence}
              lists={t.lists}
              onAdd={t.addWords}
              onCreateList={t.createNamedList}
            />
          )}

          {paraStudy && t.para && (
            <>
              {hasActions && (
                <div className="reader__actions">
                  {addAllWords.length > 0 && (
                    <AddToListButton
                      words={addAllWords}
                      lists={t.lists}
                      label={tr("translate.addAll", { n: addAllWords.length, noun: noun(addAllWords.length) })}
                      onAdd={t.addWords}
                      onCreateList={t.createNamedList}
                      className="btn reader__addall"
                    />
                  )}
                  {t.addableCount > 0 && (
                    <button
                      className="btn"
                      onClick={() => setQuiz({ words: t.addablePrimaries, mode: "learn" })}
                    >
                      {tr("translate.quizNew", { n: t.addableCount, noun: noun(t.addableCount) })}
                    </button>
                  )}
                  {t.reviewableCount > 0 && (
                    <button
                      className="btn"
                      onClick={() => setQuiz({ words: t.reviewablePrimaries, mode: "review" })}
                    >
                      {tr("translate.reviewSaved", { n: t.reviewableCount, noun: noun(t.reviewableCount) })}
                    </button>
                  )}
                  {/* "Explore related words" needs the word-map (pgvector embeddings),
                      which currently exists only for Japanese. Hide it for other
                      learning languages until their embeddings ship. */}
                  {t.learning === "JA" && (
                    <button className="btn btn--ghost" disabled={t.domainLoading} onClick={onExplore}>
                      {t.domainLoading ? tr("translate.exploreLoading") : tr("translate.explore")}
                    </button>
                  )}
                </div>
              )}
              {domainNote && <p className="review__scope">{domainNote}</p>}
              <ParagraphReader
                text={t.analyzedInput}
                tokens={t.para.tokens}
                meaningsByWord={t.para.meanings}
                saved={t.saved}
                confidence={t.confidence}
                lists={t.lists}
                onAdd={t.addWords}
                onCreateList={t.createNamedList}
              />
            </>
          )}
        </div>
      )}
    </section>
  );
}
