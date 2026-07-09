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
import { HandwritingCanvas } from "../components/translate/HandwritingCanvas";
import { PencilIcon, MicIcon, StopIcon, XIcon, CameraIcon } from "../components/common/icons";
import { isOcrAvailable, captureText } from "../services/ocr";
import { TextQuizView, type QuizMode } from "./TextQuizView";
import { targetOptions, AUTO_DETECT } from "../services/language";
import { isHandwritingAvailable } from "../services/handwriting";
import { isSpeechAvailable, startSpeech, stopSpeech, SpeechPermissionError } from "../services/speech";
import { useI18n } from "../i18n";
import { ErrorText } from "../components/common/ErrorText";
import type { Word } from "../services/words/repository";
import "../components/translate/translate.css";

export function TranslateView({ userId }: { userId: string }) {
  const t = useTranslate(userId);
  const { t: tr } = useI18n();
  const noun = (n: number) => tr(n === 1 ? "common.word" : "common.words");
  const [quiz, setQuiz] = useState<{ cards: Word[][]; mode: QuizMode } | null>(null);
  const [domainNote, setDomainNote] = useState<string | null>(null);

  // Handwriting input (native on-device recognizer): show the draw affordance only
  // where a backend is usable (iOS ML Kit today; hidden on web/desktop). Recognize
  // in the SOURCE language — the drawing becomes input text — falling back to the
  // language being learned when source is auto-detect (nothing to detect yet).
  const recognitionLang = t.source === AUTO_DETECT ? t.learning : t.source;
  const [hwAvailable, setHwAvailable] = useState(false);
  const [drawing, setDrawing] = useState(false);
  useEffect(() => {
    void isHandwritingAvailable(recognitionLang).then(setHwAvailable);
  }, [recognitionLang]);

  // Voice input (native on-device speech): record → wait for finish → append the
  // transcript to the input. The mic button toggles start/stop; a tap while
  // listening calls stopSpeech(), which makes the pending startSpeech resolve.
  const [speechAvailable, setSpeechAvailable] = useState(false);
  const [listening, setListening] = useState(false);
  const [speechError, setSpeechError] = useState<string | null>(null);
  useEffect(() => {
    void isSpeechAvailable(recognitionLang).then(setSpeechAvailable);
  }, [recognitionLang]);
  const onMic = async () => {
    if (listening) {
      await stopSpeech();
      return;
    }
    setSpeechError(null);
    setListening(true);
    try {
      const [transcript] = await startSpeech({ lang: recognitionLang });
      if (transcript) t.setInput((prev) => (prev ? `${prev}${transcript}` : transcript));
    } catch (e) {
      setSpeechError(
        e instanceof SpeechPermissionError ? tr("speech.denied") : tr("speech.error"),
      );
    } finally {
      setListening(false);
    }
  };

  // Camera OCR (Mode A): photo → recognized text in reading order → translate it
  // (straight into the paragraph reader). Native-only; hidden where unavailable.
  const [ocrAvailable, setOcrAvailable] = useState(false);
  const [ocrBusy, setOcrBusy] = useState(false);
  const [ocrError, setOcrError] = useState<string | null>(null);
  useEffect(() => {
    void isOcrAvailable(recognitionLang).then(setOcrAvailable);
  }, [recognitionLang]);
  const onCamera = async () => {
    setOcrError(null);
    setOcrBusy(true);
    try {
      const text = await captureText({ lang: recognitionLang });
      if (text.trim()) {
        t.setInput(text);
        await t.submit({ text });
      } else {
        setOcrError(tr("ocr.noText"));
      }
    } catch (err) {
      // Surface the real reason (denied permission, no camera on a simulator, …)
      // so a failure to even open the camera isn't mistaken for "no text found".
      const detail = err instanceof Error ? err.message : "";
      setOcrError(detail ? `${tr("ocr.error")} (${detail})` : tr("ocr.error"));
    } finally {
      setOcrBusy(false);
    }
  };

  // #12 — expand the paragraph into related domain words at the user's level, then
  // quiz them (a learn session, so they're added + feed SRS + refine the level).
  const onExplore = async () => {
    setDomainNote(null);
    const words = await t.exploreDomain();
    // Domain words are one chosen sense each → singleton cards (no cycling).
    if (words.length > 0) setQuiz({ cards: words.map((w) => [w]), mode: "learn" });
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
          cards={quiz.cards}
          lists={t.lists}
          mode={quiz.mode}
          onGraded={t.applyReview}
          onCreateList={t.createNamedList}
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

      {/* Two boxes: input (left) | output (right). The input carries a top-right
          tool bar (handwriting now; speech/camera will join it). Drawing opens as
          an OVERLAY over both boxes, so the page never grows or scrolls. */}
      <div className="translate__io">
        <div className="translate__inputwrap">
          <textarea
            className="textarea translate__box"
            value={t.input}
            onChange={(e) => t.setInput(e.target.value)}
            placeholder={tr("translate.inputPlaceholder")}
            rows={4}
            aria-label={tr("translate.inputAria")}
          />
          {(t.input.trim() !== "" || speechAvailable || hwAvailable || ocrAvailable) && (
            <div className="io__tools">
              {t.input.trim() !== "" && (
                <button
                  className="io__tool"
                  onClick={() => t.setInput("")}
                  aria-label={tr("translate.clearInput")}
                  title={tr("translate.clearInput")}
                >
                  <XIcon />
                </button>
              )}
              {hwAvailable && (
                <button
                  className="io__tool"
                  onClick={() => setDrawing((v) => !v)}
                  aria-pressed={drawing}
                  aria-label={tr("handwriting.draw")}
                  title={tr("handwriting.draw")}
                >
                  <PencilIcon />
                </button>
              )}
              {speechAvailable && (
                <button
                  className={`io__tool${listening ? " io__tool--rec" : ""}`}
                  onClick={onMic}
                  aria-pressed={listening}
                  aria-label={tr(listening ? "speech.stop" : "speech.start")}
                  title={tr(listening ? "speech.stop" : "speech.start")}
                >
                  {listening ? <StopIcon /> : <MicIcon />}
                </button>
              )}
              {ocrAvailable && (
                <button
                  className="io__tool"
                  onClick={onCamera}
                  disabled={ocrBusy}
                  aria-label={tr("ocr.capture")}
                  title={tr("ocr.capture")}
                >
                  {ocrBusy ? "…" : <CameraIcon />}
                </button>
              )}
            </div>
          )}
        </div>
        <div className="translate__box translate__out" aria-label={tr("translate.outputAria")}>
          {t.status === "loading" ? (
            <span className="translate__placeholder">{tr("translate.translating")}</span>
          ) : t.output ? (
            t.output
          ) : (
            <span className="translate__placeholder">{tr("translate.outputPlaceholder")}</span>
          )}
        </div>

        {drawing && (
          <div className="translate__overlay">
            <HandwritingCanvas
              lang={recognitionLang}
              onPick={(text) => t.setInput(t.input + text)}
              onClose={() => setDrawing(false)}
            />
          </div>
        )}
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

      <ErrorText message={t.error} />
      <ErrorText message={speechError} />
      <ErrorText message={ocrError} />

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
                      onClick={() => setQuiz({ cards: t.addableCards, mode: "learn" })}
                    >
                      {tr("translate.quizNew", { n: t.addableCount, noun: noun(t.addableCount) })}
                    </button>
                  )}
                  {t.reviewableCount > 0 && (
                    <button
                      className="btn"
                      onClick={() => setQuiz({ cards: t.reviewablePrimaries.map((w) => [w]), mode: "review" })}
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
