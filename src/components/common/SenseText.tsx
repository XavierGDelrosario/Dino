// Shared inline display of one dictionary sense: headword · reading → meaning ·
// reading. Pure presentation — depends ONLY on the Word type (no hooks/services)
// — so the Translate results, the paragraph popover, and the Lists "Add word"
// results render senses identically without coupling to each other.
import type { Word } from "../../services/words/repository";
import "./SenseText.css";

export function SenseText({
  word,
  primary = false,
  hideHeadword = false,
}: {
  word: Word;
  /** Larger headword for a prominent primary result. */
  primary?: boolean;
  /** Omit the headword (e.g. the paragraph popover already shows the word). */
  hideHeadword?: boolean;
}) {
  return (
    <span className="sensetext">
      {!hideHeadword && (
        <span className={`sensetext__head${primary ? " sensetext__head--primary" : ""}`}>
          {word.input}
        </span>
      )}
      {word.inputReading && <span className="sensetext__reading">{word.inputReading}</span>}
      <span className="sensetext__arrow">→</span>
      <span className="sensetext__meaning">{word.translation}</span>
      {word.translationReading && (
        <span className="sensetext__reading">{word.translationReading}</span>
      )}
    </span>
  );
}
