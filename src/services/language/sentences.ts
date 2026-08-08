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

/**
 * Split `text` into sentences, keeping each one's offsets in the source.
 *
 * Terminators: 。！？!?… , a `.` that is not a decimal point, and a hard line
 * break (a headline or list item has no terminator but is its own sentence).
 * Whitespace-only runs are dropped, so the returned spans need not be
 * contiguous — the reader renders the gaps from the source text.
 *
 * OUTPUT: Sentence[] in reading order, never overlapping.
 */
export function splitSentences(text: string): Sentence[] {
  const out: Sentence[] = [];
  let cursor = 0; // start of the sentence being accumulated

  const push = (end: number) => {
    const raw = text.slice(cursor, end);
    const lead = raw.length - raw.trimStart().length;
    const trimmed = raw.trim();
    if (trimmed) out.push({ text: trimmed, start: cursor + lead, end: cursor + lead + trimmed.length });
    cursor = end;
  };

  let depth = 0; // open brackets/quotations enclosing the current position

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    // Hard line break: closes whatever came before it, terminator or not. An
    // unclosed bracket can't span a line break, so the depth resets with it.
    if (c === "\n") {
      push(i);
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
    push(j);
    i = j - 1;
  }

  push(text.length);
  return out;
}
