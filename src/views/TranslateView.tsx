// Google-Translate-style surface: a language bar (source · ⇄ swap · target, where swap
// also moves the output into the input and re-translates), the input and output boxes,
// a Translate button, then the STUDY section — add/quiz/review controls plus the
// word-by-word reader.
//
// Submit is a BUTTON, never Enter (IME safety). A quiz/review session is a FULL
// takeover, so nothing can interfere mid-session.
import { useEffect, useState } from "react";
import { useTranslate } from "../hooks/useTranslate";
import { LangBar } from "../components/translate/LangBar";
import { ParagraphReader } from "../components/translate/ParagraphReader";
import { useLiveReader } from "../hooks/useLiveReader";
import { useDictation } from "../hooks/useDictation";
import { WordResults } from "../components/translate/WordResults";
import { AddToListButton } from "../components/translate/AddToListButton";
import { HandwritingCanvas } from "../components/translate/HandwritingCanvas";
import { HistoryMenu } from "../components/translate/HistoryMenu";
import { PencilIcon, MicIcon, StopIcon, XIcon, CameraIcon, ImageIcon } from "../components/common/icons";
import { SpeakButton } from "../components/common/SpeakButton";
import { isOcrAvailable, capturePhoto, recognizeText, type OcrSource } from "../services/ocr";
import { ImageCropper } from "../components/translate/ImageCropper";
import { TextQuizView, type QuizMode } from "./TextQuizView";
import { targetOptions, AUTO_DETECT, resolveSourceLanguage } from "../services/language";
import { isHandwritingAvailable } from "../services/handwriting";
import { useI18n } from "../i18n";
import { ErrorText } from "../components/common/ErrorText";
import type { Word } from "../services/words/repository";
import type { MediaSource } from "../services/media/mediawiki";
import "../components/translate/translate.css";

export function TranslateView({
  userId,
  initialText,
  initialSource,
  onInitialConsumed,
}: {
  userId: string;
  /** Text to load + translate on arrival (e.g. a media article from MediaView). */
  initialText?: string;
  /** Attribution for `initialText` (credit + link-back), shown alongside the prose. */
  initialSource?: MediaSource;
  onInitialConsumed?: () => void;
}) {
  const t = useTranslate(userId);

  // The reader, live under the input: free by construction and limited to finished
  // sentences (see useLiveReader). It YIELDS to a submitted result — that paragraph is
  // authoritative and may carry a gloss the live one never buys, so a second reader
  // under it would be a stale duplicate.
  const live = useLiveReader({
    text: t.input,
    source: t.source,
    learning: t.learning,
    enabled:
      t.status !== "loading" &&
      !(t.status === "done" && t.mode === "paragraph" && t.para !== null),
  });

  const { t: tr } = useI18n();
  const noun = (n: number) => tr(n === 1 ? "common.word" : "common.words");
  const [quiz, setQuiz] = useState<{ cards: Word[][]; mode: QuizMode } | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  // Attribution for text loaded from Media — cleared the moment the user edits the
  // input (the credit no longer describes what's shown).
  const [credit, setCredit] = useState<MediaSource | null>(null);

  // Load-and-translate a text handed in from another surface (the Media "Study"
  // button). Runs once per distinct text, then tells the parent it's consumed.
  useEffect(() => {
    if (!initialText) return;
    t.setInput(initialText);
    setCredit(initialSource ?? null);
    // A handed-in text can be a FULL article, so skip the gloss and let a long one
    // render the reader instead of tripping the char limit; the "Show translation"
    // toggle buys it on demand. (No caller today — Media reads in place in ArticleView
    // — this is the seam for the next source that hands text in.)
    void t.submit({ text: initialText, skipGloss: true });
    onInitialConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialText]);

  // Recognize (handwriting, OCR) in the SOURCE language — the result becomes input text
  // — falling back to the learning language under auto-detect, since there is nothing
  // to detect yet.
  const recognitionLang = t.source === AUTO_DETECT ? t.learning : t.source;
  // Read-aloud is the one input-side affordance that HAS the text, so under "Detect" it
  // resolves from what was actually typed; otherwise typing English while studying JA
  // reads it out with a Japanese voice. Handwriting/OCR run before any text exists,
  // which is why they keep recognitionLang.
  const speakLang = resolveSourceLanguage(t.input, t.source);
  const [hwAvailable, setHwAvailable] = useState(false);
  const [drawing, setDrawing] = useState(false);
  useEffect(() => {
    void isHandwritingAvailable(recognitionLang).then(setHwAvailable);
  }, [recognitionLang]);

  // Voice input dictates STRAIGHT INTO the box above, one utterance at a time, and the
  // live reader colours it as it lands — so speech reuses the whole typing surface
  // instead of a parallel transcript screen. A speaker's pause becomes a sentence break.
  const dictation = useDictation({
    lang: t.learning,
    value: t.input,
    onChange: (next) => {
      t.setInput(next);
      if (credit) setCredit(null);
    },
  });

  // Camera OCR (Mode A): photo → recognized text in reading order → translate it
  // (straight into the paragraph reader). Native-only; hidden where unavailable.
  const [ocrAvailable, setOcrAvailable] = useState(false);
  const [ocrBusy, setOcrBusy] = useState(false);
  const [ocrError, setOcrError] = useState<string | null>(null);
  useEffect(() => {
    void isOcrAvailable(recognitionLang).then(setOcrAvailable);
  }, [recognitionLang]);
  // The photo waiting to be cropped (data: URL for display + the original bytes, so
  // an uncropped confirm can skip the canvas round-trip entirely).
  const [photo, setPhoto] = useState<{ url: string; base64: string } | null>(null);

  /** Camera or photo library — identical from here on: crop, then recognize. The
   *  source only decides which sheet opens, so the two buttons share this path. */
  const onCamera = async (source: OcrSource = "camera") => {
    setOcrError(null);
    setOcrBusy(true);
    try {
      // Photo FIRST, recognition after the crop: Vision reads everything in frame, so
      // the facing page and header would otherwise land in the input too — worse for a
      // library image, where a screenshot carries the whole UI around the text.
      const image = await capturePhoto({ source });
      if (image) {
        setPhoto({ url: `data:image/${image.format};base64,${image.base64}`, base64: image.base64 });
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

  /** Cropper confirmed: `cropped` is the selected region, or null for the whole photo. */
  const onCropped = async (cropped: string | null) => {
    if (!photo) return;
    setOcrError(null);
    setOcrBusy(true);
    try {
      const text = await recognizeText({ base64: cropped ?? photo.base64, lang: recognitionLang });
      setPhoto(null);
      if (text.trim()) {
        t.setInput(text);
        await t.submit({ text });
      } else {
        // The photo is dismissed: a failed read usually means the crop was wrong, and
        // the message is more useful next to the camera button.
        setOcrError(tr("ocr.noText"));
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : "";
      setOcrError(detail ? `${tr("ocr.error")} (${detail})` : tr("ocr.error"));
    } finally {
      setOcrBusy(false);
    }
  };

  // Colour the LIVE reader by what the user already knows. Its meanings come from the
  // free dictionary path, but the saved/confidence state behind the colouring was only
  // ever loaded by submit — so until you pressed a button, a word you know perfectly
  // showed as "addable". One user_words read per new sense, deduped inside the hook.
  const { syncSenseState } = t; // destructured so the effect depends on IT, not all of `t`
  useEffect(() => {
    if (!live.para) return;
    const ids: string[] = [];
    live.para.meanings.forEach((senses) => senses.forEach((s) => ids.push(s.wordId)));
    void syncSenseState(ids);
  }, [live.para, syncSenseState]);

  // Whether the reader comes up with its English already showing — set only when the
  // user asked via "Show translation" (see askForTranslation), so the plain Translate
  // button leaves the reader source-first.
  const [openGloss, setOpenGloss] = useState(false);
  // Snapshot a paragraph's NEW words ONCE when its result arrives: the live
  // addablePrimaries empties as words save, which would unmount the "Add all" button
  // mid-interaction, so it is deliberately excluded from the deps.
  const [addAllWords, setAddAllWords] = useState<Word[]>([]);
  useEffect(() => {
    if (t.status === "done" && t.mode === "paragraph") setAddAllWords(t.addablePrimaries);
    else if (t.status !== "done") setAddAllWords([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t.status, t.mode, t.para]);

  // Quiz/review = full takeover. The normal .review column, NOT the wide .translate
  // breakout, so the card matches Review / Learn / Calibration.
  if (quiz) {
    return (
      <section className="review">
        <TextQuizView
          userId={userId}
          cards={quiz.cards}
          lists={t.lists}
          mode={quiz.mode}
          context={t.contextByWord}
          onGraded={t.applyReview}
          onCreateList={t.createNamedList}
          onClose={() => setQuiz(null)}
        />
      </section>
    );
  }

  const wordStudy = t.status === "done" && t.mode === "word" && t.meanings.length > 0;
  const paraStudy = t.status === "done" && t.mode === "paragraph" && t.para;

  /** "Show translation" on the live reader: run the same submit the button runs.
   *  The live reader is replaced by the submitted one, so remember that the English
   *  was ASKED for — otherwise the reader that arrives hides the gloss it just
   *  bought, and the press reads as having done nothing. */
  const askForTranslation = async () => {
    setOpenGloss(true);
    await t.submit();
  };
  const hasActions =
    addAllWords.length > 0 || t.addableCount > 0 || t.reviewableCount > 0 || !!paraStudy;

  return (
    <section className="translate">
      {/* The history clock is absolutely positioned so .langbar keeps its own centring:
          in the flow it would drag the selects off-centre, and shift them the moment
          the first entry appeared. */}
      <div className="translate__toolbar">
        <LangBar
          source={t.source}
          target={t.target}
          onSource={t.setSource}
          onTarget={t.setTarget}
          onSwap={t.swap}
        />
        {t.history.length > 0 && (
          <HistoryMenu
            entries={t.history}
            open={historyOpen}
            onToggle={() => setHistoryOpen((v) => !v)}
            onClose={() => setHistoryOpen(false)}
            onPick={t.replayHistory}
            onClear={t.clearHistory}
            disabled={t.status === "loading"}
          />
        )}
      </div>

      {/* Input (left) | output (right), with the input's tools in its top-right corner.
          Drawing opens as an OVERLAY over both boxes, so the page never grows. */}
      <div className="translate__io">
        <div className="translate__inputwrap">
          <textarea
            className="textarea translate__box"
            value={t.input}
            onChange={(e) => {
              t.setInput(e.target.value);
              if (credit) setCredit(null);
            }}
            // A Japanese IME holds intermediate kana in the field mid-conversion, so
            // live analysis pauses for the duration — tokenizing that flickers garbage
            // as you pick the kanji. Same reason submit is a button, never Enter.
            onCompositionStart={() => live.setComposing(true)}
            onCompositionEnd={() => live.setComposing(false)}
            placeholder={tr("translate.inputPlaceholder")}
            rows={4}
            aria-label={tr("translate.inputAria")}
          />
          {(t.input.trim() !== "" || hwAvailable || ocrAvailable || dictation.available || import.meta.env.DEV) && (
            <div className="io__tools">
              {/* Order: clear · draw · mic · picture. Clear first because it acts on
                  what's already there; then the three ways to PUT something in, in
                  ascending order of how much screen they take over. */}
              {t.input.trim() !== "" && (
                <button
                  className="io__tool"
                  onClick={() => {
                    t.setInput("");
                    setCredit(null);
                  }}
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
              {/* The mic DICTATES into the box above — press once to start, again to
                  stop — rather than opening a screen of its own. Both backends stream,
                  so `available` is what gates it; the DEV clause keeps it reachable via
                  the mock in a browser that has neither. */}
              {(dictation.available || import.meta.env.DEV) && (
                <button
                  /* Listening is a MODE the user must be able to see and leave, so it
                     says so twice — the red pulse and a stop square in place of the
                     mic. An accent border alone reads the same as hover. */
                  className={`io__tool${dictation.listening ? " io__tool--rec" : ""}`}
                  onClick={dictation.available ? dictation.toggle : dictation.startMock}
                  aria-pressed={dictation.listening}
                  aria-label={dictation.listening ? tr("listen.stop") : tr("listen.tool")}
                  title={dictation.listening ? tr("listen.stop") : tr("listen.tool")}
                >
                  {dictation.listening ? <StopIcon /> : <MicIcon />}
                </button>
              )}
              {ocrAvailable && (
                <>
                  <button
                    className="io__tool"
                    onClick={() => void onCamera("camera")}
                    disabled={ocrBusy}
                    aria-label={tr("ocr.capture")}
                    title={tr("ocr.capture")}
                  >
                    {ocrBusy ? "…" : <CameraIcon />}
                  </button>
                  {/* Photo LIBRARY gets its own button rather than an action sheet on
                      the camera: most text worth scanning is already on the phone and
                      can't be re-photographed, so hiding it behind a second step would
                      bury the more common source behind the rarer one. */}
                  <button
                    className="io__tool"
                    onClick={() => void onCamera("library")}
                    disabled={ocrBusy}
                    aria-label={tr("ocr.library")}
                    title={tr("ocr.library")}
                  >
                    {ocrBusy ? "…" : <ImageIcon />}
                  </button>
                </>
              )}
            </div>
          )}
          {/* Read-aloud, bottom-right of the box — the opposite corner from the input
              modalities. The input is spoken in the language of the INPUT ITSELF, since
              "auto-detect" is not a voice; see speakLang. */}
          <div className="io__speak">
            <SpeakButton className="io__tool" text={t.input} lang={speakLang} />
          </div>
        </div>
        <div className="translate__outwrap">
          <div className="translate__box translate__out text-selectable" aria-label={tr("translate.outputAria")}>
            {t.status === "loading" ? (
              <span className="translate__placeholder">{tr("translate.translating")}</span>
            ) : t.output ? (
              t.output
            ) : (
              <span className="translate__placeholder">{tr("translate.outputPlaceholder")}</span>
            )}
          </div>
          {/* The translation, in the TARGET language — the side it's written in. */}
          <div className="io__speak">
            <SpeakButton className="io__tool" text={t.output ?? ""} lang={t.target} />
          </div>
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

        {/* Crop the photo before recognizing it. Unlike the handwriting pad this is a
            FULL-SCREEN modal (--modal): the handwriting pad fits inside the two boxes,
            but a photo is capped at 60vh plus a hint and an action row, so it overflowed
            them — and the box-sized backdrop left the page text below showing straight
            through the picture. Cancel drops the photo; confirm sends the selection. */}
        {photo && (
          <div className="translate__overlay translate__overlay--modal">
            <ImageCropper
              src={photo.url}
              busy={ocrBusy}
              onCancel={() => setPhoto(null)}
              onCrop={onCropped}
            />
          </div>
        )}
      </div>

      <div className="translate__submit">
        <button
          className="btn"
          onClick={() => {
            setOpenGloss(false); // Japanese-first; the reader's own toggle reveals it
            void t.submit();
          }}
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
      <ErrorText message={ocrError} />
      {/* A failed recognizer must not read as a failed translation — its own line. */}
      <ErrorText message={dictation.error} />

      {/* The translation shows above as soon as it's ready; the word-by-word reader
          (kuromoji + lookups) streams in after — spinner while it loads. */}
      {t.mode === "paragraph" && t.readerLoading && !t.para && (
        <p className="reader__loading">{tr("translate.readerLoading")}</p>
      )}

      {/* EXPERIMENT — the live reader. Sits between the input and the study section:
          it is what you get for free while typing, and it disappears the moment a
          submitted result takes over. No gloss is fetched here, so the "Show
          translation" toggle inside it is the first thing that ever costs money. */}
      {!paraStudy && live.para && live.analyzed && (
        <div className="study study--live">
          <ParagraphReader
            text={live.analyzed}
            tokens={live.para.tokens}
            meaningsByWord={live.para.meanings}
            sentences={live.para.sentences}
            // The live reader buys its OWN English, exactly like the conversation
            // listener: tap one sentence, or take the lot. These used to point at
            // t.loadSentenceGloss, which works on the SUBMITTED paragraph — so with
            // nothing submitted it returned immediately and no line could ever be
            // bought here. Both paths share the sentence cache, so tapping a few
            // and then pressing the toggle pays only for what's left.
            onTranslateSentence={live.translateSentence}
            // "Show translation" IS Translate. It used to buy only the gloss, which
            // left it visibly weaker than the button beside it: no output box, and
            // words still uncoloured because the saved/confidence state is loaded by
            // submit. Same work now, so the only difference is that this one opens
            // the English (and can put it away again).
            //
            // No double spend: submit's paragraph gloss and this toggle both go
            // through glossSentences, which is content-addressed by sentence, so
            // whichever runs second pays for nothing.
            onLoadGloss={askForTranslation}
            glossLoading={t.status === "loading"}
            saved={t.saved}
            confidence={t.confidence}
            lists={t.lists}
            onAdd={t.addWords}
            onCreateList={t.createNamedList}
          />
        </div>
      )}

      {/* STUDY section: add/quiz/review controls + the hover-for-meaning reader. */}
      {(wordStudy || paraStudy) && (
        <div className="study">
          {credit && (
            <p className="reader__source">
              {tr("media.creditPrefix")}{" "}
              <a href={credit.url} target="_blank" rel="noopener noreferrer">
                {credit.label} ↗
              </a>
              {" · "}
              {credit.attribution}
            </p>
          )}
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
                      className="btn"
                    />
                  )}
                  {/* ONE quiz slot, not two. New words come first — that is what a
                      reader is here for — and only once there are none left does the
                      same position offer the saved words instead. Showing both put
                      three buttons in a row for a text that was mostly known, and the
                      review one won attention it had not earned. */}
                  {t.addableCount > 0 ? (
                    <button
                      className="btn"
                      onClick={() => setQuiz({ cards: t.addableCards, mode: "learn" })}
                    >
                      {tr("translate.quizNew", { n: t.addableCount, noun: noun(t.addableCount) })}
                    </button>
                  ) : (
                    t.reviewableCount > 0 && (
                      <button
                        className="btn"
                        onClick={() => setQuiz({ cards: t.reviewablePrimaries.map((w) => [w]), mode: "review" })}
                      >
                        {tr("translate.reviewSaved", { n: t.reviewableCount, noun: noun(t.reviewableCount) })}
                      </button>
                    )
                  )}
                </div>
              )}
              <ParagraphReader
                text={t.analyzedInput}
                tokens={t.para.tokens}
                meaningsByWord={t.para.meanings}
                sentences={t.para.sentences}
                onLoadGloss={t.loadGloss}
                onTranslateSentence={t.loadSentenceGloss}
                glossLoading={t.glossLoading}
                openGloss={openGloss}
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
