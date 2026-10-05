// =========================================================
// Sentence segmentation — the unit of the INLINE reader gloss.
//
// The paragraph gloss used to be ONE machine translation of the whole text,
// shown in a box away from the Japanese. Reading it meant hopping between two
// blocks. To put the English *under each sentence* we need a 1:1 mapping, and
// the only way to guarantee one is to make each sentence its own translation
// unit (see `translateSegments`) — splitting a single blob of English back
// apart drifts the moment MT merges or splits a sentence.
//
// TRADE-OFF (deliberate): a sentence translated in isolation loses its
// antecedent, and Japanese is pro-drop — 「行った」 alone can come back "I went"
// where the paragraph meant "he went". Exact alignment is worth more than
// cross-sentence context in a study reader, but the loss is real.
//
// PURE (no I/O), like `furiganaFor` / `retrievability`. Offsets are into the
// ORIGINAL string so the reader can slice its already-computed tokens per
// sentence rather than re-analyzing.
// =========================================================

/** One sentence: its trimmed text plus its span in the source string. */
export interface Sentence {
  text: string;
  /** Index of the first character in the source string. */
  start: number;
  /** Index one past the last character in the source string. */
  end: number;
}

// Full stops that END a sentence outright. `.` is handled separately (it is
// also a decimal point and an abbreviation mark).
const TERMINATORS = new Set(["。", "！", "？", "!", "?", "…"]);

// Closing punctuation that belongs to the sentence it follows, so 「…だ。」 keeps
// its bracket instead of orphaning it onto the next sentence.
const CLOSERS = new Set(["」", "』", "）", "〉", "》", "】", ")", "”", "’", '"', "'"]);

// Bracket pairs, tracked as a DEPTH so a full stop *inside* a quotation doesn't
// split the sentence that contains it: 彼は「行くよ。」と言った。 is ONE sentence.
// Only unambiguous pairs are counted — ASCII " and ' are the same character
// open and closed, so they can't be depth-tracked (they're handled by the
// closer-absorption below instead).
const OPEN_BRACKETS = new Set(["「", "『", "（", "〈", "《", "【", "("]);
const CLOSE_BRACKETS = new Set(["」", "』", "）", "〉", "》", "】", ")"]);

const isDigit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9";

/** Does a sentence span (as `splitSentences` cuts them) close on a terminator — as
 *  opposed to running out, or ending on a comma? Closing brackets after it are allowed. */
export function endsSentence(span: string): boolean {
  let i = span.length - 1;
  while (i >= 0 && CLOSERS.has(span[i])) i--;
  return i >= 0 && (TERMINATORS.has(span[i]) || span[i] === ".");
}

/**
 * `text` with a full stop added when it runs out on a word — 「雨です」 → 「雨です。」,
 * "It rained" → "It rained." — and unchanged otherwise.
 *
 * WHY: every unit downstream is a sentence, and a last sentence with no terminator has
 * no mark for the reader to hang its translation on. Dictation is the common source:
 * iOS places the closing 。 only once the NEXT words arrive, so the final sentence of
 * anything spoken ends bare.
 *
 * Only after a LETTER or DIGIT. Text ending on any punctuation — a terminator, a comma,
 * a bracket, a dash — is left as its writer had it: a second mark there is a guess.
 * The mark follows the script of that last character: 。 after kana/kanji, `.` otherwise
 * (Latin, and Korean, which writes a Western full stop). Trailing whitespace is dropped.
 *
 * The CALLER decides whether the text is a sentence at all — a single word must not
 * get one (猫 is a lookup, 猫。 is a paragraph). PURE.
 */
export function withFinalStop(text: string): string {
  const body = text.replace(/\s+$/u, "");
  const last = Array.from(body).pop();
  if (!last || !/[\p{L}\p{N}]/u.test(last)) return text;
  const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]/u.test(last);
  return body + (cjk ? "。" : ".");
}

/**
 * Split `text` into sentences, keeping each one's offsets in the source.
 *
 * Terminators: 。！？!?… , a `.` that is not a decimal point, and — conditionally —
 * a hard line break. A line break is a boundary only when nothing better follows:
 * a line with no terminator of its own MERGES FORWARD into the next punctuated
 * sentence of its paragraph (see `mergeUnterminated`), and stays its own sentence
 * only when no such sentence exists (lyrics, a headline, unpunctuated dictation).
 * Whitespace-only runs are dropped, so the returned spans need not be
 * contiguous — the reader renders the gaps from the source text.
 *
 * OUTPUT: Sentence[] in reading order, never overlapping.
 */
export function splitSentences(text: string): Sentence[] {
  const out: Sentence[] = [];
  // Parallel to `out`: did the span close on a terminator, or just run out of line?
  const terminated: boolean[] = [];
  let cursor = 0; // start of the sentence being accumulated

  const push = (end: number, closed: boolean) => {
    const raw = text.slice(cursor, end);
    const lead = raw.length - raw.trimStart().length;
    const trimmed = raw.trim();
    if (trimmed) {
      out.push({ text: trimmed, start: cursor + lead, end: cursor + lead + trimmed.length });
      terminated.push(closed);
    }
    cursor = end;
  };

  let depth = 0; // open brackets/quotations enclosing the current position

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    // Hard line break: closes whatever came before it, terminator or not. An
    // unclosed bracket can't span a line break, so the depth resets with it.
    if (c === "\n") {
      push(i, false);
      cursor = i + 1;
      depth = 0;
      continue;
    }

    if (OPEN_BRACKETS.has(c)) depth++;
    else if (CLOSE_BRACKETS.has(c) && depth > 0) depth--;

    // A terminator inside a quotation ends the QUOTED clause, not the sentence
    // carrying it — keep accumulating until the bracket closes.
    if (depth > 0) continue;

    const terminates =
      TERMINATORS.has(c) ||
      // `.` ends a sentence only at a boundary, and never between digits (3.14).
      (c === "." && !isDigit(text[i - 1]) && !isDigit(text[i + 1]));
    if (!terminates) continue;

    // Absorb any run of terminators (「…!?」) plus the closing punctuation after it.
    let j = i + 1;
    while (j < text.length && (TERMINATORS.has(text[j]) || text[j] === ".")) j++;
    while (j < text.length && CLOSERS.has(text[j])) j++;
    push(j, true);
    i = j - 1;
  }

  push(text.length, false);
  return mergeUnterminated(text, out, terminated);
}

// A blank line: a paragraph break, which a sentence never spans.
const PARAGRAPH_BREAK = /\n[^\S\n]*\n/;

/**
 * Fold each line that has no terminator into the next sentence that does.
 *
 * WHY: the reader hangs a sentence's translate control — and its English — on the
 * terminator that ends it. A line that ends only at a line break has no mark, so in
 * text that mixes the two (dictation the recognizer punctuated only in places, a
 * hard-wrapped paste) that line was translated, billed and never shown. Merged
 * forward it is read together with the sentence it runs into, and answered at that
 * sentence's mark.
 *
 * NOT merged, so the line break stays the boundary:
 *  - a line with no punctuated sentence after it — text with no punctuation anywhere
 *    still splits per line, which is the only boundary such text has;
 *  - across a blank line — a headline stays out of the body's first sentence, and a
 *    stanza out of the next one.
 */
function mergeUnterminated(text: string, spans: Sentence[], terminated: boolean[]): Sentence[] {
  const out: Sentence[] = [];
  let pending = -1; // index in `spans` of the first unterminated line being carried

  const flush = (upTo: number) => {
    // Nothing punctuated arrived to absorb them: each stays its own sentence.
    if (pending >= 0) for (let k = pending; k < upTo; k++) out.push(spans[k]);
    pending = -1;
  };

  for (let i = 0; i < spans.length; i++) {
    if (i > 0 && PARAGRAPH_BREAK.test(text.slice(spans[i - 1].end, spans[i].start))) flush(i);
    if (!terminated[i]) {
      if (pending < 0) pending = i;
      continue;
    }
    if (pending < 0) {
      out.push(spans[i]);
      continue;
    }
    const start = spans[pending].start;
    const end = spans[i].end;
    out.push({ text: text.slice(start, end), start, end });
    pending = -1;
  }
  flush(spans.length);
  return out;
}
