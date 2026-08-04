// =========================================================
// "Show in context" — the source sentences a quizzed word appeared in (PURE, tested).
//
// A flashcard strips a word out of the text it came from, which is exactly what makes
// it a recall test — but it also throws away the sentence that gave the word its
// meaning. This rebuilds that link: word → the sentence(s) it occurred in, with the
// occurrence offsets so the UI can highlight the surface form (行った, not the
// headword 行く) rather than string-matching for it.
//
// KEYED BY THE PRIMARY SENSE'S wordId, because that is how a quiz CARD is identified
// everywhere else: useTranslate's `addableCards` and the article word list both take
// `meaningsByWord.get(token.text)` and treat `senses[0]` as the card. Keying on the
// token TEXT instead would miss, since a card carries the dictionary headword while
// the text holds an inflected surface.
// =========================================================

import { isContentPos, type AnalyzedToken } from "../language";
import type { SentenceGloss } from "../lookup";
import type { Word } from "../words/repository";

/** One sentence a word occurred in, ready to render. */
export interface WordContext {
  /** The sentence exactly as it appears in the source text. */
  text: string;
  /** That sentence's translation, when the reader has loaded one (else null). */
  gloss: string | null;
  /** Offsets INSIDE `text` where this word occurred — for highlighting. */
  spans: { start: number; end: number }[];
}

export interface ContextInput {
  tokens: AnalyzedToken[];
  meaningsByWord: Map<string, Word[]>;
  /** The reader's sentence split, with offsets into the analyzed text. */
  sentences: SentenceGloss[];
}

/**
 * Map each word (by primary-sense `wordId`) to the sentences it appears in.
 *
 * A word repeated inside ONE sentence yields one entry with several `spans`, so the
 * panel shows the sentence once with every occurrence highlighted. Sentences keep
 * first-appearance order. Tokens that fall outside every sentence range (or words
 * with no dictionary entry) are skipped. PURE.
 */
export function contextByWord(input: ContextInput): Map<string, WordContext[]> {
  const { tokens, meaningsByWord, sentences } = input;
  const out = new Map<string, WordContext[]>();
  if (sentences.length === 0) return out;

  for (const token of tokens) {
    if (!isContentPos(token.pos)) continue;
    const senses = meaningsByWord.get(token.text);
    if (!senses || senses.length === 0) continue; // no entry → never a card
    const key = senses[0].wordId;

    // The sentence containing this occurrence. Sentences are non-overlapping and
    // in order, so the first one whose range covers the token start is the one.
    const sentence = sentences.find((s) => token.start >= s.start && token.start < s.end);
    if (!sentence) continue;

    const list = out.get(key) ?? [];
    const span = { start: token.start - sentence.start, end: token.end - sentence.start };
    const existing = list.find((c) => c.text === sentence.text);
    if (existing) {
      // Same sentence twice (the word repeats) — one entry, two highlights.
      if (!existing.spans.some((s) => s.start === span.start)) existing.spans.push(span);
      continue;
    }
    list.push({ text: sentence.text, gloss: sentence.gloss, spans: [span] });
    out.set(key, list);
  }

  return out;
}

/**
 * Split a sentence into alternating plain / highlighted parts for rendering.
 * OUTPUT: segments in document order; `hit` marks an occurrence of the word.
 * Out-of-range or overlapping spans are ignored rather than throwing. PURE.
 */
export function highlightSegments(
  text: string,
  spans: { start: number; end: number }[],
): { text: string; hit: boolean }[] {
  const valid = spans
    .filter((s) => s.start >= 0 && s.end <= text.length && s.end > s.start)
    .sort((a, b) => a.start - b.start);

  const out: { text: string; hit: boolean }[] = [];
  let cursor = 0;
  for (const s of valid) {
    if (s.start < cursor) continue; // overlaps the previous highlight — skip
    if (s.start > cursor) out.push({ text: text.slice(cursor, s.start), hit: false });
    out.push({ text: text.slice(s.start, s.end), hit: true });
    cursor = s.end;
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor), hit: false });
  return out;
}
