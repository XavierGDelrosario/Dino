// Shared word-info ("?") affordance: a small round "?" button that toggles a
// floating panel showing the word's Level (JLPT/CEFR via getProficiency) and
// Part of Speech (JMdict codes → one coarse category). Used by BOTH a Lists row
// and a flashcard, so the two surfaces stay identical (extract-once).
//
// A TAP-toggle panel, not a native `title` tooltip: tooltips don't fire on touch
// (this app targets iOS) — same rationale as the original ListRow "?".
import { useEffect, useRef, useState, type ReactNode } from "react";
import { getProficiency } from "../../services/proficiency";
import { frequencyCommonness } from "../../services/difficulty";
import { partOfSpeechCategory, type PosCategory, type LangCode } from "../../services/language";
import { useI18n, type MessageKey } from "../../i18n";
import "./wordinfo.css";

/** The word-like shape the panel needs (both a Word and a UserWord satisfy it). */
export interface WordInfoTarget {
  sourceLang: LangCode;
  proficiencyBand: number | null;
  partOfSpeech: string[] | null;
  /** Corpus frequency (Zipf ×100) → a plain-language "Commonness" band. */
  frequency: number | null;
}

/** Commonness band 1..5 (1 = most common) → its i18n label key. */
const COMMONNESS_LABEL_KEY: Record<number, MessageKey> = {
  1: "commonness.veryCommon",
  2: "commonness.common",
  3: "commonness.fairlyCommon",
  4: "commonness.uncommon",
  5: "commonness.rare",
};

/** Coarse POS category → its i18n label key (statically typed so `t` stays checked). */
const POS_LABEL_KEY: Record<PosCategory, MessageKey> = {
  noun: "pos.noun",
  pronoun: "pos.pronoun",
  verb: "pos.verb",
  adjective: "pos.adjective",
  adverb: "pos.adverb",
  particle: "pos.particle",
  conjunction: "pos.conjunction",
  interjection: "pos.interjection",
  auxiliary: "pos.auxiliary",
  counter: "pos.counter",
  prefix: "pos.prefix",
  suffix: "pos.suffix",
  numeric: "pos.numeric",
  determiner: "pos.determiner",
  expression: "pos.expression",
};

/** The Level + Commonness + Part-of-Speech rows — the shared panel CONTENT. */
export function WordInfo({ word }: { word: WordInfoTarget }) {
  const { t } = useI18n();
  const prof = getProficiency(word);
  const pos = partOfSpeechCategory(word.partOfSpeech);
  const commonness = frequencyCommonness(word);
  return (
    <>
      <span>
        {t("wordinfo.level")}: {prof ? prof.label : t("wordinfo.unknown")}
      </span>
      <span>
        {t("wordinfo.commonness")}:{" "}
        {commonness ? t(COMMONNESS_LABEL_KEY[commonness]) : t("wordinfo.unknown")}
      </span>
      <span>
        {t("wordinfo.pos")}: {pos ? t(POS_LABEL_KEY[pos]) : t("wordinfo.unknown")}
      </span>
    </>
  );
}

/**
 * The "?" button + its floating panel (Level + POS, plus any `extra` rows the
 * caller appends — e.g. the Lists row's added/reviewed dates). Self-contained:
 * click toggles; hover also reveals on desktop (pure CSS). `onClick` stops
 * propagation so it never flips/swipes an enclosing flashcard.
 */
export function WordInfoButton({
  word,
  extra,
  align = "right",
}: {
  word: WordInfoTarget;
  /** Extra rows appended below Level + POS (rendered inside the same panel). */
  extra?: ReactNode;
  /** Which edge the panel aligns to (default right). Use "left" near a right edge. */
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const { t } = useI18n();
  const wrapRef = useRef<HTMLSpanElement>(null);

  // While open, dismiss on a tap/click outside the wrap (button + panel) or on
  // Escape. pointerdown (capture) fires on iOS WKWebView + desktop; a pointerdown
  // ON the button is inside the wrap, so its own toggle still works.
  useEffect(() => {
    if (!open) return;
    const onOutside = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onOutside, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onOutside, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <span className="wordinfo-wrap" ref={wrapRef}>
      <button
        type="button"
        className="wordinfo-btn"
        aria-label={t("wordinfo.aria")}
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        ?
      </button>
      <div className={`wordinfo-panel wordinfo-panel--${align}`} role="note">
        <WordInfo word={word} />
        {extra}
      </div>
    </span>
  );
}
