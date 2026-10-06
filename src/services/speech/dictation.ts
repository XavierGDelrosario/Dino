// =========================================================
// Assembling dictated speech into the translate input box.
//
// DICTATION WRITES PROSE, NOT LINES. Each utterance is appended to what is already
// in the box on the SAME line — the way the text would have been typed. Dictation
// never inserts a line break: a break per breath chopped the box into fragments
// that looked nothing like the sentence being said.
//
// NO GUESSED PUNCTUATION — WITH ONE ENGLISH EXCEPTION. A pause is evidence the
// speaker stopped, not of which mark belongs there, and a wrong 。 is baked into text
// the user then saves. Japanese keeps that rule. ENGLISH (any Latin-script utterance)
// gets a full stop when a pause ends an utterance that has no mark of its own
// (closeLatinUtterance, founder call 2026-10-06): iOS delivers English punctuation
// almost only in the FINAL result, which continuous dictation never sees — partials
// carry the capital letters but not the periods — and a period at a pause is right
// far more often than wrong in English. The one guard: no period after a pause on a
// function word ("I went to the … store"), where the sentence is plainly unfinished.
// So unpunctuated speech arrives as one unpunctuated run; because the text lands in
// an EDITABLE box, anyone who wants a boundary can type one.
//
// THE COST, and who pays it: every downstream unit in this app is a SENTENCE, and
// `splitSentences` only cuts on a terminator or a line break. Speech the recognizer
// leaves unpunctuated is therefore ONE sentence however long the speaker talks — one
// translation unit, re-sent whole when it grows. The live reader does not wait for a
// terminator that may never come: `useDictation` reports what has been committed, and
// the reader treats that as finished text (see `settled` in useLiveReader).
//
// PUNCTUATION THE RECOGNIZER SUPPLIES IS KEPT. iOS 16+ punctuates from the audio
// (providers/native), and that is evidence of which mark belongs where. It has one
// timing quirk handled here: the mark that closes an utterance often arrives only once
// the NEXT words do, so it shows up at the head of the next utterance (「。明日は」). A
// leading closing mark is moved back onto the end of the text it closes.
//
// PURE (no I/O), like `splitSentences` and `furiganaFor` — the hook owns the
// recognizer, this owns the string.
// =========================================================

import { endsSentence, splitSentences } from "../language/sentences";

/** The utterance stops on a comma — the speaker is mid-sentence, whatever the pause. */
export const ENDS_ON_COMMA = /[、，,]\s*$/u;

/** Closing marks at the very start of an utterance — punctuation that belongs to the
 *  text before it. Opening brackets (「) are not in the set: they start the new
 *  utterance; nor are straight quotes, which open one as often as they close one. */
const LEADING_CLOSERS = /^[。．.、，,！？!?…」』）〉》】)”’]+/u;

/**
 * Hand an utterance's leading closing marks back to the end of `base`. With nothing to
 * attach to (an empty box) the marks are dropped — text starting with 。 is never right.
 * A mark `base` already ends with isn't doubled.
 */
function reattachLeadingMarks(base: string, text: string): { base: string; text: string } {
  const marks = LEADING_CLOSERS.exec(text)?.[0];
  if (!marks) return { base, text };
  const rest = text.slice(marks.length).trim();
  if (base === "") return { base, text: rest };
  // A line break the USER typed stays where it is; the mark goes before it.
  const line = base.replace(/\s+$/u, "");
  const trailing = base.slice(line.length);
  return { base: (line.endsWith(marks) ? line : line + marks) + trailing, text: rest };
}

/**
 * `base` followed by `text` on the same line. Scripts written without spaces need
 * nothing between (雨です。明日は); Latin-script text needs a space ("It rained.
 * Tomorrow"). Whitespace already there — including a break the user typed — is kept.
 */
function join(base: string, text: string): string {
  if (base === "" || /\s$/u.test(base)) return base + text;
  return base + (base.charCodeAt(base.length - 1) < 0x80 ? " " : "") + text;
}

/**
 * Commit one finished utterance onto the text already in the box.
 *
 * INPUT: `base` — everything committed so far (may be text the user typed before
 * ever pressing the mic); `utterance` — one finalized recognition result.
 * OUTPUT: the new box contents, with the utterance appended on the same line.
 *
 * An empty/whitespace utterance is dropped rather than committed: recognizers emit
 * one when a pause brought no speech.
 */
export function commitUtterance(base: string, utterance: string): string {
  const moved = reattachLeadingMarks(base, utterance.trim());
  if (!moved.text) return moved.base;
  return join(moved.base, closeLatinUtterance(moved.text));
}

/** Ends in a Latin letter or a digit — a sentence the recognizer left open. */
const OPEN_LATIN = /[A-Za-z0-9\u00C0-\u024F]$/u;

/** Words a sentence does not end on. A pause after one is a breath, not a full stop. */
const UNFINISHED = new Set([
  "a", "an", "the", "to", "of", "in", "on", "at", "for", "from", "by", "with", "about",
  "into", "onto", "than", "as", "and", "or", "but", "so", "if", "because", "when",
  "while", "is", "are", "was", "were", "be", "been", "am", "do", "does", "did", "have",
  "has", "had", "will", "would", "can", "could", "should", "my", "your", "his", "her",
  "its", "our", "their", "this", "that", "these", "those", "very", "not", "no", "i",
]);

/**
 * A Latin-script utterance that ends on a word gets a full stop; one that already ends
 * on a mark (the recognizer's own, or a comma that holds the sentence open) is kept as
 * is, and so is one whose last word says the sentence is not finished.
 */
export function closeLatinUtterance(text: string): string {
  if (!OPEN_LATIN.test(text)) return text;
  const last = text.slice(text.search(/\S+$/u)).toLowerCase();
  if (UNFINISHED.has(last)) return text;
  return text + ".";
}

/**
 * The box contents while an utterance is still FORMING.
 *
 * The partial is shown after everything committed but is not itself committed —
 * the next partial replaces it, and only `commitUtterance` makes it permanent.
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
