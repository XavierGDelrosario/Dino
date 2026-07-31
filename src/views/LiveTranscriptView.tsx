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
  learning,
  saved,
  confidence,
  lists,
  onAdd,
  onCreateList,
  onClose,
}: {
  learning: LangCode;
  saved: Set<string>;
  confidence: Map<string, number>;
  lists: List[];
  onAdd: (words: Word[], listId?: string) => Promise<void>;
  onCreateList: (name: string) => Promise<string>;
  onClose: () => void;
}) {
  const live = useLiveTranscript(learning);
  const { t } = useI18n();
  const endRef = useRef<HTMLDivElement>(null);
  // Glosses bought for individual lines. Held here (not in the hook) because they
  // are a display concern: the transcript is the same with or without them.
  const [glosses, setGlosses] = useState<Record<number, string>>({});

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
      const [gloss] = await glossSentences({
        segments: [span.text],
        sourceLang: learning,
        targetLang: native,
      });
      if (gloss) setGlosses((prev) => ({ ...prev, [index]: gloss }));
    },
    [sentences, learning, native],
  );

  // "Show translation" for the WHOLE transcript. Without this the toggle had
  // nothing to buy — it only ever revealed lines already tapped, so it looked
  // broken. Cache-aware, so lines already bought one at a time are free here.
  const [glossLoading, setGlossLoading] = useState(false);
  const translateAll = useCallback(async () => {
    if (glossLoading || sentences.length === 0) return;
    setGlossLoading(true);
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
    } finally {
      setGlossLoading(false);
    }
  }, [sentences, learning, native, glossLoading]);

  // Every word in the transcript the user hasn't saved yet — the "add these" set.
  const newWords = useMemo(() => {
    const out: Word[] = [];
    const seen = new Set<string>();
    for (const token of live.merged.tokens) {
      if (!isContentPos(token.pos)) continue;
      const primary = live.merged.meanings.get(token.text)?.[0];
      if (!primary || saved.has(primary.wordId) || seen.has(primary.wordId)) continue;
      seen.add(primary.wordId);
      out.push(primary);
    }
    return out;
  }, [live.merged, saved]);

  // Follow the speaker. Only while listening: once stopped, the user is reading
  // back and yanking them to the bottom would fight them.
  useEffect(() => {
    if (live.listening) endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [live.lines.length, live.partial, live.listening]);

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
