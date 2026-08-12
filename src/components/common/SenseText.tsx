// Shared inline display of one dictionary sense: headword · reading → meaning ·
// reading. Pure presentation — depends ONLY on the Word type (no hooks/services)
// — so the Translate results, the paragraph popover, and the Lists "Add word"
// results render senses identically without coupling to each other.
import type { Word } from "../../services/words/repository";
import { displayHeadword } from "../../services/language";
import "./SenseText.css";

export function SenseText({
  word,
  primary = false,
  hideHeadword = false,
  query,
}: {
  word: Word;
  /** Larger headword for a prominent primary result. */
  primary?: boolean;
  /** Omit the headword (e.g. the paragraph popover already shows the word). */
  hideHeadword?: boolean;
  /**
   * The term that was searched. Only a `uk` entry reads differently depending on
   * it — see displayHeadword — so a caller with no query renders exactly as before.
   */
  query?: string | null;
}) {
  const { head, reading } = displayHeadword(word, query);
  return (
    <span className="sensetext">
      {!hideHeadword && (
        <span className={`sensetext__head${primary ? " sensetext__head--primary" : ""}`}>
          {head}
        </span>
      )}
      {reading && <span className="sensetext__reading">{reading}</span>}
      <span className="sensetext__arrow">→</span>
      <span className="sensetext__meaning">{word.translation}</span>
      {word.translationReading && (
        <span className="sensetext__reading">{word.translationReading}</span>
      )}
    </span>
  );
}
