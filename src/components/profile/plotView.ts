// Zoom + pan for the History plot (plus the goal-line arithmetic at the end), as a VIEW WINDOW over data coordinates: x in bucket
// indices [0, xMax], y in value units [yMin, yMax]. The plot maps whatever window is
// current onto its fixed pixel box, so zooming is just a smaller window and panning is
// sliding it. PURE — the component owns the pointer events, this owns the arithmetic.

export interface View {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

export interface Bounds {
  /** Last bucket index (n − 1); 0 when there is at most one bucket. */
  xMax: number;
  yMin: number;
  yMax: number;
  /** Smallest spans a zoom may reach, so a window never collapses to nothing. */
  minX: number;
  minY: number;
}

export function fullView(b: Bounds): View {
  return { x0: 0, x1: b.xMax, y0: b.yMin, y1: b.yMax };
}

export function isFullView(v: View, b: Bounds): boolean {
  const eps = 1e-9;
  return v.x0 <= eps && v.x1 >= b.xMax - eps && v.y0 <= b.yMin + eps && v.y1 >= b.yMax - eps;
}

/** One axis: keep the span within [min, full] and slide the window back inside. */
function clampAxis(lo: number, hi: number, min: number, max: number, minSpan: number): [number, number] {
  const full = max - min;
  const span = Math.min(full, Math.max(Math.min(minSpan, full), hi - lo));
  let a = lo + (hi - lo - span) / 2; // re-centre if the span was clamped
  a = Math.max(min, Math.min(max - span, a));
  return [a, a + span];
}

export function clampView(v: View, b: Bounds): View {
  const [x0, x1] = clampAxis(v.x0, v.x1, 0, b.xMax, b.minX);
  const [y0, y1] = clampAxis(v.y0, v.y1, b.yMin, b.yMax, b.minY);
  return { x0, x1, y0, y1 };
}

/**
 * Zoom by `factor` (< 1 in, > 1 out) about a focus point given as FRACTIONS of the plot
 * box — fx from the left, fy from the TOP (screen order) — so the data under the cursor
 * or between the fingers stays put.
 */
export function zoomAt(v: View, b: Bounds, factor: number, fx = 0.5, fy = 0.5): View {
  const sx = v.x1 - v.x0;
  const sy = v.y1 - v.y0;
  const cx = v.x0 + fx * sx;
  const cy = v.y1 - fy * sy;
  const nsx = sx * factor;
  const nsy = sy * factor;
  const x0 = cx - fx * nsx;
  const y1 = cy + fy * nsy;
  return clampView({ x0, x1: x0 + nsx, y0: y1 - nsy, y1 }, b);
}

/**
 * Drag the CONTENT by a fraction of the plot box (dx right, dy down, in screen order),
 * i.e. the window moves the other way — like dragging a map.
 */
export function panBy(v: View, b: Bounds, dx: number, dy: number): View {
  const sx = (v.x1 - v.x0) * dx;
  const sy = (v.y1 - v.y0) * dy;
  return clampView({ x0: v.x0 - sx, x1: v.x1 - sx, y0: v.y0 + sy, y1: v.y1 + sy }, b);
}

/** Gridline values for a y window: round steps (1 · 0.5 · 0.2 · 0.1 · 0.05), ≥ 3 lines. */
export function niceTicks(y0: number, y1: number): number[] {
  const span = y1 - y0;
  const step = [1, 0.5, 0.2, 0.1, 0.05].find((s) => span / s >= 3) ?? 0.05;
  const out: number[] = [];
  for (let v = Math.ceil(y0 / step - 1e-9) * step; v <= y1 + 1e-9; v += step) out.push(Math.round(v * 100) / 100 || 0); // `|| 0`: no "-0" label
  return out;
}

/**
 * The daily goal (services/goals) as it applies to ONE bucket of the plot: per day as
 * set, ×7 on the weekly view, and none on the monthly view (months differ in length, so
 * a flat line there would be wrong for most of them) or for a metric with no goal
 * (total words, confidence). `metric` is the plot's metric id.
 */
export function goalPerBucket(
  goals: { newWords: number; reviews: number } | null | undefined,
  metric: string,
  granularity: "day" | "week" | "month",
): number | null {
  if (!goals) return null;
  const perDay = metric === "added" ? goals.newWords : metric === "reviewed" ? goals.reviews : null;
  if (perDay == null) return null;
  return granularity === "day" ? perDay : granularity === "week" ? perDay * 7 : null;
}

/**
 * The y window that fits `values` (plus `include`, the goal): padded by a tenth of the
 * span, snapped outward to the tick grid (quarter points of confidence, whole counts),
 * clamped to the metric's meaning (0–5 for confidence, ≥ 0 for counts) and never
 * narrower than one confidence point / one count, so a flat line still has room.
 */
export function fitAxis(values: number[], opts: { confidence: boolean; include?: number | null }): { yMin: number; yMax: number } {
  const all = opts.include != null ? [...values, opts.include] : values;
  if (all.length === 0) return opts.confidence ? { yMin: 0, yMax: 5 } : { yMin: 0, yMax: 1 };
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const pad = Math.max(opts.confidence ? 0.25 : 1, (hi - lo) * 0.1);
  if (opts.confidence) {
    const q = 0.25;
    let yMin = Math.max(0, Math.floor((lo - pad) / q) * q);
    let yMax = Math.min(5, Math.ceil((hi + pad) / q) * q);
    if (yMax - yMin < 1) {
      yMax = Math.min(5, yMin + 1);
      yMin = Math.max(0, yMax - 1);
    }
    return { yMin, yMax };
  }
  const yMin = Math.max(0, Math.floor(lo - pad));
  const yMax = Math.max(yMin + 1, Math.ceil(hi + pad));
  return { yMin, yMax };
}

