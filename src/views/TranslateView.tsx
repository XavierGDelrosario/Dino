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
import { useLiveReader } from "../hooks/useLiveReader";
import { LiveTranscriptView } from "./LiveTranscriptView";
import { isSpeechStreamAvailable } from "../services/speech";
import { WordResults } from "../components/translate/WordResults";
import { AddToListButton } from "../components/translate/AddToListButton";
import { HandwritingCanvas } from "../components/translate/HandwritingCanvas";
import { PencilIcon, MicIcon, XIcon, CameraIcon } from "../components/common/icons";
import { SpeakButton } from "../components/common/SpeakButton";
import { isOcrAvailable, capturePhoto, recognizeText } from "../services/ocr";
import { ImageCropper } from "../components/translate/ImageCropper";
import { TextQuizView, type QuizMode } from "./TextQuizView";
import { targetOptions, AUTO_DETECT } from "../services/language";
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

  // Placed before the other early returns so the mic session is torn down with the
  // view (the hook's cleanup stops it) rather than being left open behind a tab.
  // (Rendered below — see the `listening` branch.)

  // EXPERIMENT: the reader, live under the input. Free by construction
  // (dictionaryOnly + skipGloss) and limited to sentences the user has finished —
  // see useLiveReader. It YIELDS to a submitted result: once Translate has run,
  // that paragraph is what's on screen, and the live one would be a duplicate.
  const live = useLiveReader({
    text: t.input,
    source: t.source,
    learning: t.learning,
    // Off while a submit is in flight, and off once a submitted paragraph is on
    // screen — that result is authoritative (it may carry a gloss the live one
    // never buys), so a second reader under it would just be a stale duplicate.
    enabled:
      t.status !== "loading" &&
      !(t.status === "done" && t.mode === "paragraph" && t.para !== null),
  });

  const { t: tr } = useI18n();
  const noun = (n: number) => tr(n === 1 ? "common.word" : "common.words");
  const [quiz, setQuiz] = useState<{ cards: Word[][]; mode: QuizMode } | null>(null);
  // Attribution for text loaded from Media — cleared the moment the user edits the
  // input (the credit no longer describes what's shown).
  const [credit, setCredit] = useState<MediaSource | null>(null);

  // Load-and-translate a text handed in from another surface (the Media "Study"
  // button). Runs once per distinct text, then tells the parent it's consumed.
  useEffect(() => {
    if (!initialText) return;
    t.setInput(initialText);
    setCredit(initialSource ?? null);
    // A handed-in text can be a FULL article — skip the whole-paragraph gloss so a
    // long one renders the reader instead of tripping the char limit. The reader's
    // "Show translation" toggle buys the gloss on demand if it's wanted.
    // (No caller today: Media reads in place, in ArticleView. Kept as the seam for
    // the next source that hands text in — a share sheet, a paste, an extension.)
    void t.submit({ text: initialText, skipGloss: true });
    onInitialConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialText]);

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
  // EXPERIMENT — the live listener, opened from the input's tool bar. A takeover
  // (like the text quiz) rather than another panel: reading a conversation as it is
  // spoken is a whole screen's job, not a strip under a text box.
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [canListen, setCanListen] = useState(false);
  useEffect(() => {
    void isSpeechStreamAvailable(t.learning).then(setCanListen);
  }, [t.learning]);

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

  const onCamera = async () => {
    setOcrError(null);
    setOcrBusy(true);
    try {
      // Photo FIRST, recognition after the crop — Vision reads everything in frame,
      // so the facing page and the header would otherwise land in the input too.
      const image = await capturePhoto();
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
        // Keep the photo on screen? No — a failed read usually means the crop was
        // wrong, and the message is more useful next to the camera button.
        setOcrError(tr("ocr.noText"));
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : "";
      setOcrError(detail ? `${tr("ocr.error")} (${detail})` : tr("ocr.error"));
    } finally {
      setOcrBusy(false);
    }
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

  // Quiz/review = full takeover: the entire translate surface is hidden. Use the
  // normal .review column (NOT the wide .translate breakout) so the card is the same
  // size as Review / Learn / Calibration.
  if (transcriptOpen) {
    return (
      <LiveTranscriptView
        userId={userId}
        learning={t.learning}
        saved={t.saved}
        confidence={t.confidence}
        lists={t.lists}
        onAdd={t.addWords}
        onCreateList={t.createNamedList}
        onGraded={t.applyReview}
        onClose={() => setTranscriptOpen(false)}
      />
    );
  }

  if (quiz) {
    return (
      <section className="review">
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
            onChange={(e) => {
              t.setInput(e.target.value);
              if (credit) setCredit(null);
            }}
            // A Japanese IME holds intermediate romaji/kana in the field while
            // converting, so live analysis pauses for the duration — tokenizing a
            // half-converted string produces garbage that flickers as you pick the
            // kanji. Same reason submit is a button and never Enter.
            onCompositionStart={() => live.setComposing(true)}
            onCompositionEnd={() => live.setComposing(false)}
            placeholder={tr("translate.inputPlaceholder")}
            rows={4}
            aria-label={tr("translate.inputAria")}
          />
          {(t.input.trim() !== "" || hwAvailable || ocrAvailable || canListen || import.meta.env.DEV) && (
            <div className="io__tools">
              {/* Order, top to bottom: clear · draw · mic · picture. Clear first
                  because it acts on what is already in the box; then the three ways
                  to PUT something in it, in ascending order of how much they take
                  over the screen (a pad, a listening session, the camera). */}
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
              {/* The mic opens the LIVE transcript — one continuous session read as
                  it is spoken. It replaces record-then-fill entirely. Streaming is
                  implemented on BOTH backends now (native on-device, and Web Speech
                  in Chrome), so `canListen` is what gates it; the DEV clause only
                  keeps it reachable in a browser that has neither. */}
              {(canListen || import.meta.env.DEV) && (
                <button
                  className="io__tool"
                  onClick={() => setTranscriptOpen(true)}
                  aria-label={tr("listen.tool")}
                  title={tr("listen.tool")}
                >
                  <MicIcon />
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
          {/* Read-aloud sits BOTTOM-right, clear of the top-right modality tools —
              flush, matching the output box (the textarea's resize grip, which used
              to own this corner, is gone; see .textarea in translate.css).
              The input is spoken in the source language — resolved the same way
              handwriting/speech resolve it, since "auto-detect" isn't a voice. */}
          <div className="io__speak">
            <SpeakButton className="io__tool" text={t.input} lang={recognitionLang} />
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

        {/* Crop the photo before recognizing it — same overlay slot as handwriting,
            so the page never grows. Cancel drops the photo (the camera can be
            reopened); confirm sends just the selection to OCR. */}
        {photo && (
          <div className="translate__overlay">
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
      <ErrorText message={ocrError} />

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
            onLoadGloss={live.translateAll}
            glossLoading={live.glossLoading}
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
