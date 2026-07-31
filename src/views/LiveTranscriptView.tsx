// =========================================================
// EXPERIMENT — the live listener.
//
// Listens to a conversation and prints it as it is spoken, coloured by what you
// know: grey = no dictionary entry · blue = addable · red→green by confidence.
// Tap a word for its meaning, ＋ to save it — the same reader used everywhere
// else, so a conversation becomes vocabulary without a copy-paste step.
//
// Two zones, and the split is the point: FINALIZED utterances above, analyzed and
// interactive, and the utterance currently forming below in plain grey. Recognition
// rewrites a partial constantly, so colouring it would flicker; committing it is
// what earns the colour.
// =========================================================
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLiveTranscript } from "../hooks/useLiveTranscript";
import { ParagraphReader } from "../components/translate/ParagraphReader";
import { ErrorText } from "../components/common/ErrorText";
import { TextQuizView } from "./TextQuizView";
import type { OnGraded } from "../hooks/useTextQuiz";
import { errorMessage } from "../lib/errorMessage";
import { AddToListButton } from "../components/translate/AddToListButton";
import { BackIcon, MicIcon, StopIcon } from "../components/common/icons";
import { splitSentences } from "../services/language";
import { glossSentences, getCachedGloss } from "../services/translation";
import { SUPPORTED_LANGUAGES, type LangCode as Lang } from "../services/language";
import { isContentPos } from "../services/language";
import { plural, useI18n } from "../i18n";
import type { LangCode } from "../services/language";
import type { List } from "../services/lists";
import type { Word } from "../services/words/repository";
import "../components/translate/translate.css";

export function LiveTranscriptView({
  userId,
  learning,
  saved,
  confidence,
  lists,
  onAdd,
  onCreateList,
  onClose,
  onGraded,
}: {
  userId: string;
  learning: LangCode;
  saved: Set<string>;
  confidence: Map<string, number>;
  lists: List[];
  onAdd: (words: Word[], listId?: string) => Promise<void>;
  onCreateList: (name: string) => Promise<string>;
  onClose: () => void;
  /** Sync the caller's saved/confidence state as each word is learned. */
  onGraded?: OnGraded;
}) {
  const live = useLiveTranscript(learning);
  const { t } = useI18n();
  const endRef = useRef<HTMLDivElement>(null);
  // Glosses bought for individual lines. Held here (not in the hook) because they
  // are a display concern: the transcript is the same with or without them.
  const [glosses, setGlosses] = useState<Record<number, string>>({});
  // Why the English did not appear. Distinct from live.error (the recognizer):
  // a failed translation must not read as a failed transcript.
  const [glossError, setGlossError] = useState<string | null>(null);

  const native: Lang = SUPPORTED_LANGUAGES.find((l) => l.code !== learning)?.code ?? learning;

  // Sentence spans over the merged transcript — what the punctuation buttons index
  // into, and what the English is keyed to.
  const sentences = useMemo(() => {
    const spans = splitSentences(live.merged.text);
    return spans.map((s, i) => ({ ...s, gloss: glosses[i] ?? getCachedGloss(s.text, learning, native) ?? null }));
  }, [live.merged.text, glosses, learning, native]);

  // Buy ONE line. Shared cache with the paragraph reader, so a sentence bought here
  // is free if the same text is translated again anywhere else this session.
  const translateSentence = useCallback(
    async (index: number) => {
      const span = sentences[index];
      if (!span || span.gloss) return;
      setGlossError(null);
      try {
        const [gloss] = await glossSentences({
          segments: [span.text],
          sourceLang: learning,
          targetLang: native,
        });
        // A null gloss is not an exception — the provider ran and returned
        // nothing (quota, an MT kill-switch, an unsupported pair). Silence here
        // is what made this look like "translation just doesn't work".
        if (gloss) setGlosses((prev) => ({ ...prev, [index]: gloss }));
        else setGlossError(t("listen.glossEmpty"));
      } catch (e) {
        setGlossError(errorMessage(e));
      }
    },
    [sentences, learning, native, t],
  );

  // "Show translation" for the WHOLE transcript. Without this the toggle had
  // nothing to buy — it only ever revealed lines already tapped, so it looked
  // broken. Cache-aware, so lines already bought one at a time are free here.
  const [glossLoading, setGlossLoading] = useState(false);
  const translateAll = useCallback(async () => {
    if (glossLoading || sentences.length === 0) return;
    setGlossLoading(true);
    setGlossError(null);
    try {
      const fetched = await glossSentences({
        segments: sentences.map((s) => s.text),
        sourceLang: learning,
        targetLang: native,
      });
      setGlosses((prev) => {
        const next = { ...prev };
        fetched.forEach((gloss, i) => {
          if (gloss) next[i] = gloss;
        });
        return next;
      });
      if (fetched.every((g) => !g)) setGlossError(t("listen.glossEmpty"));
    } catch (e) {
      setGlossError(errorMessage(e));
    } finally {
      setGlossLoading(false);
    }
  }, [sentences, learning, native, glossLoading, t]);

  // Every word in the transcript the user hasn't saved yet. `newWords` is the
  // primary sense of each (the "add these" set); `newCards` carries ALL senses of
  // the same words, primary first, so the quiz can cycle meanings and add the one
  // that was actually meant — same shape as the reader's addableCards.
  const { newWords, newCards } = useMemo(() => {
    const words: Word[] = [];
    const cards: Word[][] = [];
    const seen = new Set<string>();
    for (const token of live.merged.tokens) {
      if (!isContentPos(token.pos)) continue;
      const senses = live.merged.meanings.get(token.text) ?? [];
      const primary = senses[0];
      if (!primary || saved.has(primary.wordId) || seen.has(primary.wordId)) continue;
      seen.add(primary.wordId);
      words.push(primary);
      cards.push(senses);
    }
    return { newWords: words, newCards: cards };
  }, [live.merged, saved]);

  // Quizzing is a FULL takeover, like it is from the reader: a flashcard session
  // over the words this conversation just taught. Rendered below, before the
  // transcript, so nothing of the listener is on screen behind it.
  const [quizzing, setQuizzing] = useState(false);

  // Follow the speaker. Only while listening: once stopped, the user is reading
  // back and yanking them to the bottom would fight them.
  useEffect(() => {
    if (live.listening) endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [live.lines.length, live.partial, live.listening]);

  if (quizzing) {
    return (
      <section className="review">
        <TextQuizView
          userId={userId}
          cards={newCards}
          lists={lists}
          mode="learn"
          onGraded={onGraded}
          onCreateList={onCreateList}
          onClose={() => setQuizzing(false)}
        />
      </section>
    );
  }

  return (
    <section className="review listen">
      <div className="listen__bar">
        {/* Back, not close: this is a surface you came INTO from Translate, so the
            arrow says where it returns you rather than implying the session is a
            dialog to dismiss. */}
        <button
          className="iconbtn listen__back"
          onClick={onClose}
          aria-label={t("common.back")}
          title={t("common.back")}
        >
          <BackIcon />
        </button>
        {/* The mic IS the control: it starts the session and stops it, so the bar
            reads as one instrument rather than a labelled pair of commands. */}
        <button
          className={`btn btn--sm ${live.listening ? "btn--danger" : "btn--primary"}`}
          onClick={() => (live.listening ? live.stop() : void live.start())}
          disabled={live.status === "unavailable"}
          aria-label={live.listening ? t("listen.stop") : t("listen.start")}
          title={live.listening ? t("listen.stop") : t("listen.start")}
          aria-pressed={live.listening}
        >
          {live.listening ? <StopIcon /> : <MicIcon />}
        </button>
        {live.lines.length > 0 && (
          <button className="btn btn--sm" onClick={live.clear}>
            {t("listen.clear")}
          </button>
        )}
        {/* DEV ONLY — a scripted conversation on a timer, for working on this
            without Chrome (the only browser that streams) and without talking out
            loud. Stripped from a production build; goes away with the mock. */}
        {import.meta.env.DEV && !live.listening && (
          <button className="btn btn--sm" onClick={() => void live.startMock()}>
            ▶ Mock
          </button>
        )}
        {newWords.length > 0 && (
          <button className="btn btn--sm" onClick={() => setQuizzing(true)}>
            {t("listen.quizNew", {
              n: newWords.length,
              noun: plural(t, newWords.length, "common.word", "common.words"),
            })}
          </button>
        )}
        {newWords.length > 0 && (
          <AddToListButton
            className="btn btn--sm"
            words={newWords}
            lists={lists}
            label={t("listen.addAll", {
              n: newWords.length,
              noun: plural(t, newWords.length, "common.word", "common.words"),
            })}
            onAdd={onAdd}
            onCreateList={onCreateList}
          />
        )}
      </div>

      {live.status === "unavailable" && <p className="review__msg">{t("listen.unavailable")}</p>}
      <ErrorText message={live.error} />
      <ErrorText message={glossError} />

      {live.lines.length === 0 && live.status !== "unavailable" && (
        <p className="review__msg">{live.listening ? t("listen.waiting") : t("listen.idle")}</p>
      )}

      {live.lines.length > 0 && (
        <ParagraphReader
          text={live.merged.text}
          tokens={live.merged.tokens}
          meaningsByWord={live.merged.meanings}
          sentences={sentences}
          onTranslateSentence={translateSentence}
          onLoadGloss={translateAll}
          glossLoading={glossLoading}
          saved={saved}
          confidence={confidence}
          lists={lists}
          onAdd={onAdd}
          onCreateList={onCreateList}
        />
      )}

      {/* The utterance still forming — plain, because recognition keeps rewriting it. */}
      {live.partial && <p className="listen__partial">{live.partial}</p>}
      <div ref={endRef} />
    </section>
  );
}
