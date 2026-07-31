// =========================================================
// Assembling dictated speech into the translate input box.
//
// WHY THIS EXISTS AT ALL. Speech recognizers return text with NO punctuation, and
// every downstream unit in this app is a SENTENCE: `splitSentences` decides what a
// sentence is, the reader draws one clickable control per sentence, and
// `translateSegments` bills one translation per sentence. Dictated text with no
// terminators is therefore ONE sentence however long the speaker talks — which is
// exactly how the live listener failed: it never stopped, so nothing was ever a
// finished sentence.
//
// THE FIX IS A NEWLINE, NOT GUESSED PUNCTUATION. `splitSentences` treats a hard
// line break as a terminator in its own right ("a headline or list item has no
// terminator but is its own sentence"). So committing each utterance with a
// trailing "\n" turns the SPEAKER'S PAUSE into the sentence boundary — which is
// what a pause usually means anyway — without inventing a 。 that may be wrong.
// The reader already renders a boundary with no terminator: `.reader__punct--implicit`.
//
// Deliberately NOT inserting 。: a pause is evidence of a boundary, not evidence of
// which mark belongs there, and a wrong 。 is baked into text the user then saves.
// A newline is the honest encoding of "they stopped talking here", and because the
// text lands in an EDITABLE box, anyone who wants real punctuation can type it.
//
// PURE (no I/O), like `splitSentences` and `furiganaFor` — the hook owns the
// recognizer, this owns the string.
// =========================================================

/**
 * Separator between committed utterances.
 *
 * Load-bearing: this is a sentence terminator to `splitSentences`. Changing it to
 * a space would silently collapse an entire conversation into one sentence again.
 */
const SEPARATOR = "\n";

/** Ensure `base` ends on a boundary, so whatever comes next starts its own sentence. */
function onBoundary(base: string): string {
  if (base === "") return "";
  return base.endsWith(SEPARATOR) ? base : base + SEPARATOR;
}

/**
 * Commit one finished utterance onto the text already in the box.
 *
 * INPUT: `base` — everything committed so far (may be text the user typed before
 * ever pressing the mic); `utterance` — one finalized recognition result.
 * OUTPUT: the new box contents, ending on a boundary and ready for the next one.
 *
 * An empty/whitespace utterance is dropped rather than committed: recognizers emit
 * one when a pause brought no speech, and it would otherwise open a blank line.
 */
export function commitUtterance(base: string, utterance: string): string {
  const text = utterance.trim();
  if (!text) return base;
  return onBoundary(base) + text + SEPARATOR;
}

/**
 * The box contents while an utterance is still FORMING.
 *
 * The partial is shown after everything committed but is not itself committed —
 * the next partial replaces it, and only `commitUtterance` makes it permanent. It
 * gets no trailing separator, because it is not finished.
 */
export function withPartial(base: string, partial: string): string {
  const text = partial.trim();
  if (!text) return base;
  return onBoundary(base) + text;
}
