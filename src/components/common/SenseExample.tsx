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
import { useState } from "react";
import { useI18n } from "../../i18n";
import "./senseexample.css";

export function SenseExample({
  example,
  exampleGloss,
  definitionJa,
}: {
  /** Japanese sentence demonstrating this sense, or null when none is written. */
  example: string | null;
  /** English translation of the example, or null. */
  exampleGloss: string | null;
  /** Monolingual Japanese definition of this sense, or null. */
  definitionJa: string | null;
}) {
  const [open, setOpen] = useState(false);
  const { t } = useI18n();
  if (!example && !definitionJa) return null;

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
        <div className="senseex">
          {example && (
            <p className="senseex__sentence" lang="ja">
              {example}
            </p>
          )}
          {exampleGloss && <p className="senseex__gloss">{exampleGloss}</p>}
          {definitionJa && (
            <p className="senseex__definition" lang="ja">
              <span className="senseex__label">{t("sense.definition")}</span>
              {definitionJa}
            </p>
          )}
        </div>
      )}
    </>
  );
}
