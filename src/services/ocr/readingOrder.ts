// =========================================================
// Reading order (Mode A).
//
// OCR returns blocks (≈ lines) in an engine-chosen order that isn't reliable for
// Japanese, so we re-sort by geometry and join into text the reader can consume.
//
// HORIZONTAL (横書き): group blocks into rows by vertical overlap, order rows
// top→bottom, and within each row left→right.
//
// VERTICAL (縦書き — manga/novels): the mirror. Group blocks into columns by
// horizontal overlap, order columns RIGHT→LEFT, and within each column top→bottom.
// A horizontal sort scrambles a vertical page, and the block recognizer doesn't say
// which one it was given — `detectDirection` works it out from the two engines.
//
// Bucketing (not a pairwise comparator) keeps the sort a stable total order.
// =========================================================

import { endsSentence } from "../language/sentences";
import type { OcrBlock, OcrDirection, OcrResult } from "./types";

/** A row (horizontal) or column (vertical): the span it covers ACROSS the reading
 *  direction, and the blocks in it. */
interface Band {
  lo: number;
  hi: number;
  items: OcrBlock[];
}

/**
 * Bucket blocks into bands along one axis: a block joins the first band it overlaps
 * by at least half its own extent, else it starts a new one.
 */
function bands(blocks: OcrBlock[], lo: (b: OcrBlock) => number, size: (b: OcrBlock) => number): Band[] {
  const out: Band[] = [];
  for (const b of [...blocks].sort((a, c) => lo(a) - lo(c))) {
    const bLo = lo(b);
    const bHi = bLo + size(b);
    const band = out.find((r) => Math.min(r.hi, bHi) - Math.max(r.lo, bLo) >= size(b) * 0.5);
    if (band) {
      band.items.push(b);
      band.lo = Math.min(band.lo, bLo);
      band.hi = Math.max(band.hi, bHi);
    } else {
      out.push({ lo: bLo, hi: bHi, items: [b] });
    }
  }
  return out;
}

/** Blocks grouped into reading-order lines: rows for horizontal text, columns for vertical. */
function readingLines(blocks: OcrBlock[], direction: OcrDirection): OcrBlock[][] {
  if (direction === "vertical") {
    return bands(blocks, (b) => b.x, (b) => b.width)
      .sort((a, c) => c.hi - a.hi) // rightmost column first
      .map((col) => col.items.sort((a, c) => a.y - c.y));
  }
  return bands(blocks, (b) => b.y, (b) => b.height)
    .sort((a, c) => a.lo - c.lo)
    .map((row) => row.items.sort((a, c) => a.x - c.x));
}

/** Blocks in reading order (horizontal unless told the text is vertical). */
export function blocksToReadingOrder(blocks: OcrBlock[], direction: OcrDirection = "horizontal"): OcrBlock[] {
  return readingLines(blocks, direction).flat();
}

/**
 * Reading-order text for the translate input / reader.
 *
 * Horizontal: one block per line, as photographed.
 *
 * Vertical: columns are joined into running text, with a line break only after a
 * column that ends a sentence. Vertical prose wraps mid-word at the foot of every
 * column, and a break there would split the word for the analyzer; the cost is that
 * two unpunctuated speech bubbles side by side run together.
 */
export function blocksToText(blocks: OcrBlock[], direction: OcrDirection = "horizontal"): string {
  if (direction === "horizontal") {
    return blocksToReadingOrder(blocks)
      .map((b) => b.text.trim())
      .filter(Boolean)
      .join("\n");
  }
  return joinVerticalLines(readingLines(blocks, "vertical").map((col) => col.map((b) => b.text.trim()).join("")));
}

/**
 * Columns of vertical text (already in reading order) → running text, with a line
 * break only after a column that ends a sentence. Shared by the block path above and
 * the transcript path, whose engine returns one line per column.
 */
export function joinVerticalLines(lines: string[]): string {
  let out = "";
  for (const line of lines) {
    const text = line.trim();
    if (!text) continue;
    out += (out && endsSentence(out) ? "\n" : "") + text;
  }
  return out;
}

const CONTENT_CHAR = /[\p{L}\p{N}]/u;
const content = (text: string): string[] => [...text].filter((c) => CONTENT_CHAR.test(c));

/** Share of the transcript the blocks must also contain to count as the same read. */
const AGREEMENT_FLOOR = 0.6;

/**
 * Which way does the photographed text run? Decided by comparing the two engines:
 *
 *  - `result` — the BLOCK recognizer, which reads horizontal lines only. Given a
 *    vertical page it returns nothing, or stray single characters, or columns it has
 *    boxed taller than wide.
 *  - `transcript` — the transcript engine (Live Text), which reads either direction.
 *
 * So the text is HORIZONTAL when the block recognizer saw what the transcript engine
 * saw (most of the transcript's characters appear in the blocks) AND its multi-
 * character boxes are wider than tall. Anything else — it found little, found
 * fragments, or found tall boxes — is a page it couldn't read: VERTICAL.
 *
 * With no transcript there is nothing to compare, and the blocks are all we have:
 * horizontal. PURE.
 */
export function detectDirection(result: OcrResult, transcript: string): OcrDirection {
  const said = content(transcript);
  if (said.length === 0) return "horizontal";

  // Characters of the transcript that the blocks also contain (as a multiset).
  const pool = new Map<string, number>();
  for (const b of result.blocks) for (const c of content(b.text)) pool.set(c, (pool.get(c) ?? 0) + 1);
  let matched = 0;
  for (const c of said) {
    const left = pool.get(c) ?? 0;
    if (left > 0) {
      matched++;
      pool.set(c, left - 1);
    }
  }
  if (matched / said.length < AGREEMENT_FLOOR) return "vertical";

  // Same characters — but were they read as LINES? Only multi-character boxes have a
  // direction; a page that came back as single characters wasn't read as lines at all.
  const lines = result.blocks.filter((b) => content(b.text).length >= 2);
  if (lines.length === 0) return said.length >= 4 ? "vertical" : "horizontal";
  const wide = lines.filter((b) => b.width * result.width >= b.height * result.height).length;
  return wide * 2 >= lines.length ? "horizontal" : "vertical";
}
