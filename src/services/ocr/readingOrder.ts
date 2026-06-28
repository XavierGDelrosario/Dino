// =========================================================
// Reading order (Mode A, phase 1: HORIZONTAL / 横書き only).
//
// OCR returns blocks (≈ lines) in an engine-chosen order that isn't reliable for
// Japanese, so we re-sort by geometry: group blocks into rows by vertical overlap,
// order rows top→bottom, and within each row left→right. Then join into text the
// reader can consume.
//
// VERTICAL (縦書き — manga/novels: columns top→bottom, right→left) is phase 2; this
// horizontal sort would scramble it, so the UI flags vertical captures until then.
// Row bucketing (not a pairwise comparator) keeps the sort a stable total order.
// =========================================================

import type { OcrBlock } from "./types";

interface Row {
  top: number;
  bottom: number;
  items: OcrBlock[];
}

/** Blocks in horizontal reading order (top→bottom rows, left→right within a row). */
export function blocksToReadingOrder(blocks: OcrBlock[]): OcrBlock[] {
  const rows: Row[] = [];
  // Seed rows in top→bottom order, then assign each block to the first row it
  // vertically overlaps (>= half its height) — else it starts a new row.
  for (const b of [...blocks].sort((a, c) => a.y - c.y)) {
    const bTop = b.y;
    const bBottom = b.y + b.height;
    const row = rows.find((r) => {
      const overlap = Math.min(r.bottom, bBottom) - Math.max(r.top, bTop);
      return overlap >= b.height * 0.5;
    });
    if (row) {
      row.items.push(b);
      row.top = Math.min(row.top, bTop);
      row.bottom = Math.max(row.bottom, bBottom);
    } else {
      rows.push({ top: bTop, bottom: bBottom, items: [b] });
    }
  }
  rows.sort((a, c) => a.top - c.top);
  return rows.flatMap((r) => r.items.sort((a, c) => a.x - c.x));
}

/** Reading-order text for the translate input / reader (one block per line). */
export function blocksToText(blocks: OcrBlock[]): string {
  return blocksToReadingOrder(blocks)
    .map((b) => b.text.trim())
    .filter(Boolean)
    .join("\n");
}
