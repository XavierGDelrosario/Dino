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
// AN UNPUNCTUATED PAUSE IS A NEWLINE, NOT GUESSED PUNCTUATION. `splitSentences`
// treats a hard line break as a boundary when the text offers nothing better. So an
// utterance the recognizer gave NO closing mark is committed with a trailing "\n":
// the speaker's pause becomes the sentence boundary — which is what a pause usually
// means anyway — without inventing a 。 that may be wrong.
//
// A PUNCTUATED UTTERANCE GETS NO NEWLINE. Its own mark already ends the sentence, so
// a break after it says nothing and only chops the box into one line per breath;
// dictated speech that the recognizer punctuates reads as continuous prose, the way
// it would have been typed. The newline is the FALLBACK boundary, not the format.
//
// Deliberately NOT inserting 。: a pause is evidence of a boundary, not evidence of
// which mark belongs there, and a wrong 。 is baked into text the user then saves.
// A newline is the honest encoding of "they stopped talking here", and because the
// text lands in an EDITABLE box, anyone who wants real punctuation can type it.
//
// PUNCTUATION THE RECOGNIZER SUPPLIES IS KEPT. iOS 16+ punctuates from the audio
// (providers/native), and that is evidence of which mark belongs where. It has one
// timing quirk handled here: the mark that closes a line often arrives only once the
// NEXT words do, so it shows up at the head of the next utterance (「。明日は」). A
// leading closing mark is moved back onto the end of the line it closes.
//
// PURE (no I/O), like `splitSentences` and `furiganaFor` — the hook owns the
// recognizer, this owns the string.
// =========================================================

import { endsSentence, splitSentences } from "../language/sentences";

/**
 * Boundary after an utterance that carries no closing mark of its own.
 *
 * Load-bearing: this is the only sentence boundary `splitSentences` has for
 * unpunctuated speech. Changing it to a space would silently collapse an entire
 * unpunctuated conversation into one sentence again.
 */
const SEPARATOR = "\n";

/** The utterance stops on a comma — the speaker is mid-sentence, whatever the pause. */
export const ENDS_ON_COMMA = /[、，,]\s*$/u;

/** Closing marks at the very start of an utterance — punctuation that belongs to the
 *  line before it. Opening brackets (「) are not in the set: they start the new line;
 *  nor are straight quotes, which open a line as often as they close one. */
const LEADING_CLOSERS = /^[。．.、，,！？!?…」』）〉》】)”’]+/u;

/**
 * Hand an utterance's leading closing marks back to the end of `base`, before its
 * trailing boundary. With nothing to attach to (an empty box) the marks are dropped —
 * a line starting with 。 is never right. A mark `base` already ends with isn't doubled.
 */
function reattachLeadingMarks(base: string, text: string): { base: string; text: string } {
  const marks = LEADING_CLOSERS.exec(text)?.[0];
  if (!marks) return { base, text };
  const rest = text.slice(marks.length).trim();
  if (base === "") return { base, text: rest };
  const line = base.endsWith(SEPARATOR) ? base.slice(0, -SEPARATOR.length) : base;
  // The line now carries its own mark, so the pause-newline that stood in for one goes.
  return { base: line.endsWith(marks) ? line : line + marks, text: rest };
}

/**
 * `base` followed by `text`, with the right thing between them: nothing but spacing
 * after a line that ends on its own punctuation (it flows on as prose), a line break
 * after one that doesn't (the break is the only boundary it has).
 */
function join(base: string, text: string): string {
  if (base === "" || base.endsWith(SEPARATOR)) return base + text;
  if (!endsSentence(base) && !ENDS_ON_COMMA.test(base)) return base + SEPARATOR + text;
  // 「雨です。明日は」 needs nothing between; "It rained. Tomorrow" needs a space.
  const last = base[base.length - 1];
  return base + (last.charCodeAt(0) < 0x80 && last !== " " ? " " : "") + text;
}

/**
 * Commit one finished utterance onto the text already in the box.
 *
 * INPUT: `base` — everything committed so far (may be text the user typed before
 * ever pressing the mic); `utterance` — one finalized recognition result.
 * OUTPUT: the new box contents, ready for the next one — ending on a line break only
 * if the utterance brought no closing mark of its own.
 *
 * An empty/whitespace utterance is dropped rather than committed: recognizers emit
 * one when a pause brought no speech, and it would otherwise open a blank line.
 */
export function commitUtterance(base: string, utterance: string): string {
  const moved = reattachLeadingMarks(base, utterance.trim());
  if (!moved.text) return moved.base;
  const joined = join(moved.base, moved.text);
  return endsSentence(moved.text) ? joined : joined + SEPARATOR;
}

/**
 * The box contents while an utterance is still FORMING.
 *
 * The partial is shown after everything committed but is not itself committed —
 * the next partial replaces it, and only `commitUtterance` makes it permanent. It
 * gets no trailing separator, because it is not finished.
 */
export function withPartial(base: string, partial: string): string {
  const moved = reattachLeadingMarks(base, partial.trim());
  if (!moved.text) return moved.base;
  return join(moved.base, moved.text);
}

/** Punctuation and whitespace — everything that isn't what was actually SAID. */
export const NON_CONTENT = /[\p{P}\s]/u;
const HAS_CONTENT = /[^\p{P}\s]/u;

/**
 * Where a punctuated utterance may be cut into a line: one past the LAST sentence
 * terminator (。．.！？!?… plus its closers), so each line runs from the previous
 * terminator to the last one. 0 when `text` has no sentence end yet.
 *
 * A bare mark at the very start doesn't count — that is the PREVIOUS line's 。 arriving
 * late (see reattachLeadingMarks), not the end of anything said in this utterance.
 * `splitSentences` decides the spans, so a 。 inside 「…」 or a decimal point never cuts.
 * PURE.
 */
export function lastSentenceEnd(text: string): number {
  const spans = splitSentences(text);
  for (let i = spans.length - 1; i >= 0; i--) {
    const s = spans[i];
    // endsSentence has no comma in it: a comma pauses a sentence, never ends one.
    if (endsSentence(s.text) && HAS_CONTENT.test(s.text)) return s.end;
  }
  return 0;
}
