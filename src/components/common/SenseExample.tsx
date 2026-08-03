// The example-sentence disclosure on a word row — ONE component, so a Lists row and
// the Media article word list behave identically rather than drifting into two
// almost-the-same affordances (CLAUDE.md: a one-sided fix reads as a bug everywhere
// else).
//
// Placement is deliberate: it sits to the LEFT of the listen button in the row's
// bottom strip, away from the header cluster of edit/tag/delete. Both are "tell me
// more about this word" rather than actions that change anything, so they belong
// together and apart from the destructive controls.
//
// Renders NOTHING when the sense has no example — the same rule SpeakButton follows
// for a missing voice. Most senses are unwritten (the corpus is authored in batches),
// and a dead button on every row would read as a broken feature rather than an absent
// sentence.
//
// ‼️ THE SENTENCE RENDERS THROUGH THE READER, not as plain text. That is the whole point
// of putting a Japanese sentence under a word: every word inside it is furigana'd,
// coloured by what the reader already knows, and addable on the spot — so looking up one
// word opens a door to the next. A plain <p> would make the example a dead end.
// `userId` is what switches it on; without one (a preview, a test) it falls back to
// plain text rather than failing.
import { useState } from "react";
import { useI18n } from "../../i18n";
import { ParagraphReader } from "../translate/ParagraphReader";
import { useSenseExampleReader } from "../../hooks/useSenseExampleReader";
import type { LangCode } from "../../services/language";
import "./senseexample.css";

export function SenseExample({
  example,
  exampleGloss,
  definitionSource,
  userId,
  sourceLang,
  targetLang,
}: {
  /** Japanese sentence demonstrating this sense, or null when none is written. */
  example: string | null;
  /** English translation of the example, or null. */
  exampleGloss: string | null;
  /** Monolingual definition in the source language, or null. */
  definitionSource: string | null;
  /** Enables the knowledge-coloured reader. Omit for a plain-text rendering. */
  userId?: string;
  sourceLang?: LangCode;
  targetLang?: LangCode;
}) {
  const [open, setOpen] = useState(false);
  const { t } = useI18n();

  // Hooks must run unconditionally, so this is called even when there is nothing to
  // show; `active` keeps it inert until the panel is actually opened.
  const reader = useSenseExampleReader({
    userId: userId ?? "",
    text: userId ? example : null,
    sourceLang: sourceLang ?? "JA",
    targetLang: targetLang ?? "EN",
    active: open && Boolean(userId),
  });

  if (!example && !definitionSource) return null;

  const label = t(open ? "sense.hideExample" : "sense.showExample");
  return (
    <>
      <button
        type="button"
        className={`iconbtn senseex__toggle${open ? " senseex__toggle--on" : ""}`}
        onClick={(e) => {
          // A Lists row is itself clickable in select mode; opening an example must
          // never also pick the word (same reason SpeakButton stops propagation).
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        aria-expanded={open}
        aria-label={label}
        title={label}
      >
        {/* 例 — the affordance names itself in the language being learned, and reads
            at a glance next to the speaker without competing with it for width. */}
        例
      </button>

      {/* The panel is a SIBLING of the row's bottom strip, not a child of it: it spans
          the whole card under a rule, which is what makes it read as the row opening
          up rather than as a tooltip hanging off the button. */}
      {open && (
        <div className="senseex" onClick={(e) => e.stopPropagation()}>
          {example &&
            (reader.ready ? (
              // The real thing: tappable, knowledge-coloured, furigana'd.
              <div className="senseex__reader">
                <ParagraphReader
                  text={example}
                  tokens={reader.tokens}
                  meaningsByWord={reader.meaningsByWord}
                  saved={reader.saved}
                  confidence={reader.confidence}
                  lists={reader.lists}
                  onAdd={reader.addWords}
                  onCreateList={reader.createNamedList}
                />
              </div>
            ) : (
              // Shown while the analysis loads, and permanently when there is no
              // userId — the sentence is always readable, colouring is the bonus.
              <p className={`senseex__sentence${reader.loading ? " is-loading" : ""}`} lang="ja">
                {example}
              </p>
            ))}
          {exampleGloss && <p className="senseex__gloss">{exampleGloss}</p>}
          {definitionSource && (
            <p className="senseex__definition" lang="ja">
              <span className="senseex__label">{t("sense.definition")}</span>
              {definitionSource}
            </p>
          )}
        </div>
      )}
    </>
  );
}
