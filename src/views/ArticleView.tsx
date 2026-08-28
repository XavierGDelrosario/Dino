// In-depth media summary page. Reached from the Media tab's "Study": analyzes a
// Wikipedia article (word lookups via the reader pipeline) and shows, in order:
//   · the summary graphs (AnalyzeInfographic — coverage + confidence/freq/level)
//   · a RECOMMENDED quiz (the article's new words, common + easy first — the fastest
//     route to ~95% comprehension; once none are left it tops up with the article's
//     least-confident saved words) + a "Read article" hand-off to the reader
//   · a sortable / filterable list of the unique registered words in the article
// Non-registered words (no dictionary entry) are disregarded throughout.
import { useEffect, useMemo, useState } from "react";
import { useTranslate, type TranslateLangs } from "../hooks/useTranslate";
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
  langs,
}: {
  userId: string;
  article: Article;
  onBack: () => void;
  /**
   * The pair to analyze this text in. Media browses a corpus that may NOT be the
   * language you study (its picker is local, like Learn's), and the text's own
   * language is the only right answer — analyzing an English article as Japanese
   * resolves nothing. Omit it and the profile decides, which is correct for a source
   * with no language of its own (pasted text, a scan).
   */
  langs?: TranslateLangs;
  /**
   * The ★ for this article, supplied by whoever opened it (Media owns the state).
   * OPTIONAL on purpose: this view is the generic analysis surface, and a source
   * with no canonical URL — pasted text, a scan — has nothing to save a pointer
   * to. Omit it and no star renders.
   */
  favorite?: FavoriteState;
}) {
  const t = useTranslate(userId, langs);
  const { t: tr } = useI18n();
  const [quiz, setQuiz] = useState<Word[][] | null>(null);
  // "Read article" stays HERE rather than handing off to the Translate tab: the
  // analysis stays mounted behind it, so Back is a setState and returns to the
  // screen you came from instead of stranding you on another tab.
  const [reading, setReading] = useState(false);

  // Analyze the article once on arrival (paragraph mode → tokens + meanings).
  // skipGloss: the summary never shows the sentence translation, so no MT call.
  //
  // It does NOT setInput: that box is `useStickyState`, so writing the article into it
  // left the WHOLE article sitting in the Translate tab's input the next time you
  // opened it. `submit` takes the text explicitly and keeps its own `analyzedInput`,
  // so the reader never needed the shared box.
  // The languages are passed EXPLICITLY, not left to the pinned state: the pin lands in
  // a setState during the same commit this effect runs in, so `submit` would still close
  // over the PREVIOUS pair. For an English article under the default profile that meant
  // source=JA / target=EN, which submit answers with its "nothing to translate" echo —
  // `para` stays null, and this view renders "Analyzing…" forever with no error. The
  // override exists for exactly this (see submit's comment about swap()).
  useEffect(() => {
    void t.submit({
      text: article.text,
      skipGloss: true,
      ...(langs ? { source: langs.learning, target: langs.native } : {}),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [article.text, langs?.learning, langs?.native]);

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
          onForgot={t.softenSenses}
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

      {/* "Analyzing" only while it IS analyzing. A finished submit that produced no
          para (the echo path, when the pair can't be translated) used to land here and
          spin forever — a silent hang is the worst way to report a failure, so a
          finished-but-empty analysis falls through to the "no words" message. */}
      {!t.para && !t.error && t.status !== "done" ? (
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
            userId={userId}
            rows={rows}
            lists={t.lists}
            onAdd={t.addWords}
            onCreateList={t.createNamedList}
            onForgot={t.softenSenses}
          />
        </>
      ) : (
        <p className="review__msg">{tr("media.noWords")}</p>
      )}
    </section>
  );
}
