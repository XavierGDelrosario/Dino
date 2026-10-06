// Shared word-info ("?") affordance: a small round "?" button that toggles a
// floating panel showing the word's Level (JLPT/CEFR via getProficiency — the curated
// band, else the stored estimate, shown alike) and
// Part of Speech (JMdict codes → one coarse category). Used by BOTH a Lists row
// and a flashcard, so the two surfaces stay identical (extract-once).
//
// A TAP-toggle panel, not a native `title` tooltip: tooltips don't fire on touch
// (this app targets iOS) — same rationale as the original ListRow "?".
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { getProficiency } from "../../services/proficiency";
import { frequencyCommonness } from "../../services/difficulty";
import { partOfSpeechCategory, type LangCode } from "../../services/language";
import { COMMONNESS_LABEL_KEY, POS_COLOR, POS_LABEL_KEY } from "./wordLabels";
import { ordinalColor } from "../../services/analyze/palette";
import { useI18n } from "../../i18n";
import "./wordinfo.css";

/** The word-like shape the panel needs (both a Word and a UserWord satisfy it). */
export interface WordInfoTarget {
  sourceLang: LangCode;
  proficiencyBand: number | null;
  partOfSpeech: string[] | null;
  /** Stored level estimate, shown when there's no curated band (see getProficiency). */
  estimatedBand?: number | null;
  /** Corpus frequency (Zipf ×100) → a plain-language "Commonness" band. */
  frequency: number | null;
}

/**
 * A value on a rounded rectangle in its own colour — the level's, the commonness
 * ramp's, the part of speech's — the same colours the charts give those values. The
 * colour is a TINT behind the text plus the outline, never the text colour itself:
 * these are chart fills, and several are too light to read as text on either theme.
 */
function Chip({ color, children }: { color: string; children: ReactNode }) {
  return (
    <span className="wordinfo-chip" style={{ "--chip": color } as CSSProperties}>
      {children}
    </span>
  );
}

/** The Level + Commonness + Part-of-Speech rows — the shared panel CONTENT. */
export function WordInfo({ word }: { word: WordInfoTarget }) {
  const { t } = useI18n();
  const prof = getProficiency(word);
  const pos = partOfSpeechCategory(word.partOfSpeech);
  const commonness = frequencyCommonness(word);
  return (
    <>
      <span>
        {t("wordinfo.level")}: {prof ? <Chip color={`var(--lvl-${prof.band})`}>{prof.label}</Chip> : t("wordinfo.unknown")}
      </span>
      <span>
        {t("wordinfo.usage")}:{" "}
        {commonness ? (
          // The same common → rare ramp the charts use (five bands across it).
          <Chip color={ordinalColor((commonness - 1) / 4)}>{t(COMMONNESS_LABEL_KEY[commonness])}</Chip>
        ) : (
          t("wordinfo.unknown")
        )}
      </span>
      <span>
        {t("wordinfo.pos")}: {pos ? <Chip color={POS_COLOR[pos]}>{t(POS_LABEL_KEY[pos])}</Chip> : t("wordinfo.unknown")}
      </span>
    </>
  );
}

/**
 * The "?" button + its floating panel, with whatever rows the caller puts in it.
 * Self-contained: click toggles; hover also reveals on desktop (pure CSS). `onClick`
 * stops propagation so it never flips/swipes an enclosing flashcard or opens the row
 * it sits in.
 */
export function InfoButton({
  ariaLabel,
  align = "right",
  children,
}: {
  ariaLabel: string;
  /** Which edge the panel aligns to (default right). Use "left" near a right edge. */
  align?: "left" | "right";
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
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
        aria-label={ariaLabel}
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        ?
      </button>
      <div className={`wordinfo-panel wordinfo-panel--${align}`} role="note">
        {children}
      </div>
    </span>
  );
}

/**
 * The word "?" — Level + Commonness + POS, plus any `extra` rows the caller appends
 * (e.g. the Lists row's added/reviewed dates).
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
  const { t } = useI18n();
  return (
    <InfoButton ariaLabel={t("wordinfo.aria")} align={align}>
      <WordInfo word={word} />
      {extra}
    </InfoButton>
  );
}
