// Pure pagination helpers, shared by the Lists + article-summary pagers (kept out of
// the Pager component file so it exports only a component — react-refresh cleanliness).

/** Rows drawn per page — the same window everywhere. */
export const PAGE_SIZE = 100;

// The page numbers to render: always first + last, plus a window around the current
// page, with "…" gaps collapsed. All 0-indexed.
export function pageWindow(current: number, count: number): (number | "gap")[] {
  const keep = new Set<number>([0, count - 1]);
  for (let p = current - 1; p <= current + 1; p++) {
    if (p >= 0 && p < count) keep.add(p);
  }
  const sorted = [...keep].sort((a, b) => a - b);
  const out: (number | "gap")[] = [];
  let prev = -1;
  for (const p of sorted) {
    if (prev >= 0 && p - prev > 1) out.push("gap");
    out.push(p);
    prev = p;
  }
  return out;
}
