// In-depth media summary page. Reached from the Media tab's "Study": analyzes a
// Wikipedia article (word lookups via the reader pipeline) and shows, in order:
//   · the summary graphs (AnalyzeInfographic — coverage + confidence/freq/level)
//   · a RECOMMENDED quiz (the article's new words, common + easy first — the fastest
//     route to ~95% comprehension; once none are left it tops up with the article's
//     least-confident saved words) + a "Read article" hand-off to the reader
//   · a sortable / filterable list of the unique registered words in the article
// Non-registered words (no dictionary entry) are disregarded throughout.
import { useEffect, useMemo, useState } from "react";
import { useTranslate } from "../hooks/useTranslate";
import { AnalyzeInfographic } from "../components/common/AnalyzeInfographic";
import { ArticleWordList } from "../components/media/ArticleWordList";
import { FavoriteStar, type FavoriteState } from "../components/media/FavoriteStar";
import { ParagraphReader } from "../components/translate/ParagraphReader";
import { TextQuizView } from "./TextQuizView";
import { summarizeReader } from "../services/analyze/summarize";
import { articleWordList, quizWords } from "../services/analyze/wordlist";
import { ErrorText } from "../components/common/ErrorText";
import { useI18n } from "../i18n";
import type { Article } from "../services/media/mediawiki";
import type { Word } from "../services/words/repository";
import "../components/media/article.css";

const RECOMMENDED_QUIZ_CAP = 20;

export function ArticleView({
  userId,
  article,
  onBack,
  favorite,
}: {
  userId: string;
  article: Article;
  onBack: () => void;
  /**
   * The ★ for this article, supplied by whoever opened it (Media owns the state).
   * OPTIONAL on purpose: this view is the generic analysis surface, and a source
   * with no canonical URL — pasted text, a scan — has nothing to save a pointer
   * to. Omit it and no star renders.
   */
  favorite?: FavoriteState;
}) {
  const t = useTranslate(userId);
  const { t: tr } = useI18n();
  const [quiz, setQuiz] = useState<Word[][] | null>(null);
  // "Read article" stays HERE rather than handing off to the Translate tab: the
  // analysis stays mounted behind it, so Back is a setState and returns to the
  // screen you came from instead of stranding you on another tab.
  const [reading, setReading] = useState(false);

  // Analyze the article once on arrival (paragraph mode → tokens + meanings).
  // skipGloss: the summary never shows the sentence translation, so no MT call.
  useEffect(() => {
    t.setInput(article.text);
    void t.submit({ text: article.text, skipGloss: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [article.text]);

  const analysis = useMemo(() => {
    if (!t.para) return null;
    return { tokens: t.para.tokens, meaningsByWord: t.para.meanings, saved: t.saved, confidence: t.confidence };
  }, [t.para, t.saved, t.confidence]);

  const rows = useMemo(() => (analysis ? articleWordList(analysis) : []), [analysis]);
  const summary = useMemo(() => (analysis ? summarizeReader(analysis) : null), [analysis]);

  // New words first, then the least-confident saved ones — so the quiz survives
  // studying the article (see quizWords). `hasNew` only picks the button's wording.
  const quizRows = useMemo(() => quizWords(rows, RECOMMENDED_QUIZ_CAP), [rows]);
  const hasNew = useMemo(() => quizRows.some((r) => r.status === "new"), [quizRows]);

  // Quiz = full takeover (same .review column sizing as Review / Learn).
  if (quiz) {
    return (
      <section className="review">
        <TextQuizView
          userId={userId}
          cards={quiz}
          lists={t.lists}
          mode="learn"
          context={t.contextByWord}
          onGraded={t.applyReview}
          onCreateList={t.createNamedList}
          onClose={() => setQuiz(null)}
        />
      </section>
    );
  }

  // READING MODE — just the article: the prose, the "Show translation" toggle,
  // and a way back. None of the analysis chrome (graphs, word list, quiz), and
  // none of the Translate tab's input/output boxes and language bar.
  if (reading && analysis) {
    return (
      <section className="review media article-read">
        <div className="article__head">
          <button className="btn btn--ghost btn--sm" onClick={() => setReading(false)}>
            ← {tr("media.backToAnalysis")}
          </button>
          <div className="article__titleRow">
            <h2 className="article__title">{article.title}</h2>
            {favorite && <FavoriteStar {...favorite} />}
          </div>
          <p className="reader__source">
            {tr("media.creditPrefix")}{" "}
            <a href={article.url} target="_blank" rel="noopener noreferrer">
              {article.title} ↗
            </a>{" "}
            · {article.attribution}
          </p>
        </div>
        <ErrorText message={t.error} />
        <ParagraphReader
          text={t.analyzedInput}
          tokens={analysis.tokens}
          meaningsByWord={analysis.meaningsByWord}
          sentences={t.para?.sentences}
          onLoadGloss={t.loadGloss}
          onTranslateSentence={t.loadSentenceGloss}
          glossLoading={t.glossLoading}
          saved={t.saved}
          confidence={t.confidence}
          lists={t.lists}
          onAdd={t.addWords}
          onCreateList={t.createNamedList}
        />
      </section>
    );
  }

  return (
    <section className="review media">
      <div className="article__head">
        <button className="btn btn--ghost btn--sm" onClick={onBack}>
          ← {tr("media.back")}
        </button>
        <div className="article__titleRow">
          <h2 className="article__title">{article.title}</h2>
          {favorite && <FavoriteStar {...favorite} />}
        </div>
        <p className="reader__source">
          {tr("media.creditPrefix")}{" "}
          <a href={article.url} target="_blank" rel="noopener noreferrer">
            {article.title} ↗
          </a>{" "}
          · {article.attribution}
        </p>
      </div>

      <ErrorText message={t.error} />

      {!t.para && !t.error ? (
        <p className="review__msg">{tr("media.analyzing")}</p>
      ) : summary && rows.length > 0 ? (
        <>
          <AnalyzeInfographic data={summary.data} />

          <div className="article__actions">
            {quizRows.length > 0 && (
              <button
                className="btn btn--primary"
                onClick={() => setQuiz(quizRows.map((r) => r.senses))}
              >
                {tr(hasNew ? "media.recommendedQuiz" : "media.reviewQuiz", { n: quizRows.length })}
              </button>
            )}
            <button className="btn btn--ghost" onClick={() => setReading(true)}>
              {tr("media.readArticle")}
            </button>
          </div>

          <ArticleWordList
            rows={rows}
            lists={t.lists}
            onAdd={t.addWords}
            onCreateList={t.createNamedList}
          />
        </>
      ) : (
        <p className="review__msg">{tr("media.noWords")}</p>
      )}
    </section>
  );
}
