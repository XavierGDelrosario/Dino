// The History line plot: words added · total words · cards reviewed · confidence, over
// 30 days (daily) · 12 weeks · 12 months. Hand-rolled SVG like AnalyzeInfographic (no
// chart library; CSP-safe) and painted only with theme tokens, so both themes work.
//
// Anatomy follows the dataviz rules: one y-axis, 2px lines, ≥8px markers, recessive
// grid, a crosshair that snaps to the nearest bucket with ONE tooltip listing every
// series there, a legend whenever there are ≥2 series, and a screen-reader table so no
// value is hover-only. Confidence draws one line per level (the ordinal easy→hard ramp
// the Difficulty bars already use) plus the overall average in the text ink; buckets
// with no snapshot are bridged, because an idle day writes nothing.
//
// Confidence only: each line has a toggle in a column BESIDE the plot (the legend,
// made clickable), and the plot zooms and pans (pinch / Ctrl-⌘-scroll / the ± buttons /
// + − 0 keys to zoom, drag to move). The level lines sit a fraction of a point apart on
// a 0–5 axis, so zooming Y is what actually separates them. The window math lives in
// plotView.ts (pure); this file only turns pointer events into calls to it.
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { useI18n, type MessageKey } from "../../i18n";
import { dayKey, parseDayKey } from "../../services/words/filters";
import {
  RANGES,
  activitySeries,
  confidenceLines,
  type HistoryRange,
  type Point,
  type ProfileHistory,
} from "../../services/history";
import { clampView, fullView, goalPerBucket, isFullView, niceTicks, panBy, zoomAt, type Bounds, type View } from "./plotView";
import type { Goals } from "../../services/goals";
import "./history.css";

type PlotMetric = "added" | "total" | "reviewed" | "confidence";

const METRICS: { value: PlotMetric; label: MessageKey }[] = [
  { value: "added", label: "history.metricAdded" },
  { value: "total", label: "history.metricTotal" },
  { value: "reviewed", label: "history.metricReviewed" },
  { value: "confidence", label: "history.metricConfidence" },
];
const RANGE_OPTS: { value: HistoryRange; label: MessageKey }[] = [
  { value: "1w", label: "history.range1w" },
  { value: "1m", label: "history.range1m" },
  { value: "3m", label: "history.range3m" },
  { value: "6m", label: "history.range6m" },
  { value: "1y", label: "history.range1y" },
];

interface Series {
  id: string;
  label: string;
  color: string;
  width: number;
  dashed?: boolean;
  points: Point[];
}

// Geometry (viewBox units; the SVG scales to its container's width).
const W = 640;
// Confidence gets a taller plot: its axis is a fixed 0–5 and the level lines sit close
// together, so the extra height spreads each whole step apart where the counts don't need it.
const H_ACTIVITY = 220;
const H_CONFIDENCE = 380;
const M = { top: 12, right: 12, bottom: 26, left: 36 };
const PW = W - M.left - M.right;

/** One ± press / one + − key. */
const ZOOM_STEP = 0.7;
/** Pointer travel (px) before a press becomes a drag rather than a tap-to-inspect. */
const DRAG_SLOP = 4;

/** A "nice" axis ceiling ≥ v (1, 2, 5 × 10^k), so gridlines land on round numbers. */
function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

/** Whole-number ticks for a zoomed ACTIVITY window (counts): about four, on a 1-2-5 step. */
function countTicks(y0: number, y1: number): number[] {
  const raw = Math.max(1, (y1 - y0) / 4);
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = Math.max(1, [1, 2, 5, 10].map((m) => m * pow).find((c) => c >= raw) ?? 10 * pow);
  const out: number[] = [];
  for (let v = Math.ceil(y0 / step - 1e-9) * step; v <= y1 + 1e-9; v += step) out.push(v);
  return out;
}

export function HistoryPlot({ history, goals }: { history: ProfileHistory; goals?: Goals | null }) {
  const { t, locale } = useI18n();
  const [metric, setMetric] = useState<PlotMetric>("added");
  const [range, setRange] = useState<HistoryRange>("1m");
  const [hover, setHover] = useState<number | null>(null);
  /** Confidence lines switched off in the side column (by series id — stable per level). */
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  /** The zoom window; null = everything. Reset whenever what's plotted changes. */
  const [view, setView] = useState<View | null>(null);
  const today = useMemo(() => new Date(), []);
  const unranked = t("history.unranked");

  const series: Series[] = useMemo(() => {
    if (metric !== "confidence") {
      return [
        {
          id: metric,
          label: t(METRICS.find((m) => m.value === metric)!.label),
          color: "var(--accent)",
          width: 2,
          points: activitySeries(history.days, metric, range, today),
        },
      ];
    }
    const lines = confidenceLines(history.confidence, range, today, history.mainLang, unranked);
    const out: Series[] = lines.bands.map((b) => ({
      id: `band-${b.slot}`,
      label: b.label,
      // One fixed categorical hue per level SLOT (--lvl-N), so a level keeps its colour
      // whichever others are present; unranked is the muted ink, dashed, so it never
      // reads as one more level.
      color: b.slot === 0 ? "var(--muted)" : `var(--lvl-${b.slot})`,
      width: 2,
      dashed: b.slot === 0,
      points: b.points,
    }));
    out.push({ id: "overall", label: t("history.overall"), color: "var(--text)", width: 3, points: lines.overall });
    return out;
  }, [metric, range, history, today, t, unranked]);

  const keys = series[0]?.points.map((p) => p.key) ?? [];
  const n = keys.length;
  const isConf = metric === "confidence";
  const H = isConf ? H_CONFIDENCE : H_ACTIVITY;
  const PH = H - M.top - M.bottom;
  const hasData = series.some((s) => s.points.some((p) => p.value != null && (isConf || p.value > 0)));
  // The goal line (dashed, in the streak colour) sits at the goal for this bucket size;
  // the axis grows to include it so a goal above every bar is still on screen.
  const goal = goalPerBucket(goals, metric, RANGES[range].granularity);
  const yMax = isConf
    ? 5
    : niceMax(Math.max(0, goal ?? 0, ...series.flatMap((s) => s.points.map((p) => p.value ?? 0))));
  const shown = isConf ? series.filter((s) => !hidden.has(s.id)) : series;

  // Every metric zooms and pans. The smallest Y window is half a point of confidence,
  // or a twentieth of an activity plot's range (never less than one whole count).
  const bounds: Bounds = {
    xMax: Math.max(0, n - 1),
    yMin: 0,
    yMax,
    minX: Math.min(2, Math.max(0, n - 1)),
    minY: isConf ? 0.5 : Math.max(1, yMax / 20),
  };
  /** A stored window resolved against the current data (null = everything). */
  const resolve = (w: View | null) => (w ? clampView(w, bounds) : fullView(bounds));
  const v = resolve(view);
  const zoomed = !isFullView(v, bounds);
  const ticks = isConf ? niceTicks(v.y0, v.y1) : zoomed ? countTicks(v.y0, v.y1) : [0, yMax / 2, yMax];

  const x = (i: number) => M.left + (v.x1 - v.x0 <= 0 ? PW / 2 : ((i - v.x0) / (v.x1 - v.x0)) * PW);
  const y = (val: number) => M.top + PH - ((val - v.y0) / (v.y1 - v.y0)) * PH;
  // First/last bucket inside the window (all of them when not zoomed).
  const lo = Math.max(0, Math.ceil(v.x0 - 1e-9));
  const hi = Math.min(n - 1, Math.floor(v.x1 + 1e-9));
  const clipId = useId();

  // Anything that changes what is plotted starts from the whole picture again.
  const resetView = () => {
    setView(null);
    setHover(null);
  };
  const zoomBy = (factor: number, fx = 0.5, fy = 0.5) => {
    setHover(null);
    setView((cur) => zoomAt(resolve(cur), bounds, factor, fx, fy));
  };

  // Drag and pinch arrive at pointer rate (often 120 Hz), and each view change re-renders
  // every series. Queue them and apply once per animation frame instead.
  const queued = useRef<Array<(w: View) => View>>([]);
  const frame = useRef<number | null>(null);
  useEffect(() => () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
  }, []);
  const moveView = (step: (w: View) => View) => {
    queued.current.push(step);
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const steps = queued.current;
      queued.current = [];
      setView((cur) => steps.reduce((w, f) => f(w), resolve(cur)));
    });
  };

  const fmtKey = (key: string, long = false) => {
    const d = parseDayKey(key);
    const g = RANGES[range].granularity;
    if (g === "month") return d.toLocaleDateString(locale, { year: long ? "numeric" : undefined, month: "short" });
    return d.toLocaleDateString(locale, { month: "short", day: "numeric", year: long ? "numeric" : undefined });
  };
  const fmtVal = (val: number | null) => (val == null ? "—" : isConf ? val.toFixed(1) : String(Math.round(val)));
  // niceTicks already rounds to the step, so the plain number prints right (1, 0.5, 0.25).
  const fmtTick = (val: number) => String(isConf ? val : Math.round(val));

  // ── Pointer: hover to inspect; drag to pan and pinch to zoom ──
  const hit = useRef<SVGRectElement>(null);
  /** Active pointers (touch fingers / a held mouse button), by id → last position. */
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  /** The press in progress: where it started and whether it has become a drag. */
  const press = useRef<{ x: number; y: number; dragging: boolean } | null>(null);

  const pickIndex = (clientX: number) => {
    const box = hit.current?.getBoundingClientRect();
    if (!box || n === 0) return;
    const frac = (clientX - box.left) / box.width;
    const i = Math.round(v.x0 + frac * (v.x1 - v.x0));
    setHover(Math.max(lo, Math.min(hi, i)));
  };

  const onPointerDown = (e: PointerEvent<SVGRectElement>) => {
    pickIndex(e.clientX);
    e.currentTarget.setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 1) press.current = { x: e.clientX, y: e.clientY, dragging: false };
    else setHover(null); // a second finger: this is a pinch, not an inspection
  };

  const onPointerMove = (e: PointerEvent<SVGRectElement>) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) {
      pickIndex(e.clientX); // plain hover
      return;
    }
    const box = e.currentTarget.getBoundingClientRect();
    const cur = { x: e.clientX, y: e.clientY };

    if (pointers.current.size >= 2) {
      // Pinch: scale by the change in finger spread, about the midpoint.
      const other = [...pointers.current.entries()].find(([id]) => id !== e.pointerId)?.[1];
      pointers.current.set(e.pointerId, cur);
      if (!other) return;
      const before = Math.hypot(prev.x - other.x, prev.y - other.y);
      const after = Math.hypot(cur.x - other.x, cur.y - other.y);
      if (before < 1 || after < 1) return;
      const fx = ((cur.x + other.x) / 2 - box.left) / box.width;
      const fy = ((cur.y + other.y) / 2 - box.top) / box.height;
      moveView((w) => zoomAt(w, bounds, before / after, fx, fy));
      return;
    }

    pointers.current.set(e.pointerId, cur);
    const p = press.current;
    if (!p) return;
    if (!p.dragging) {
      if (Math.hypot(cur.x - p.x, cur.y - p.y) < DRAG_SLOP) {
        pickIndex(e.clientX);
        return;
      }
      p.dragging = true;
      setHover(null);
    }
    moveView((w) =>
      panBy(w, bounds, (cur.x - prev.x) / box.width, (cur.y - prev.y) / box.height),
    );
  };

  const endPointer = (e: PointerEvent<SVGRectElement>) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size === 0) press.current = null;
  };

  // Ctrl/⌘ + wheel zooms — which is also what a trackpad pinch sends. A plain wheel is
  // left alone so the page still scrolls past the chart. Native listener: React's
  // onWheel is passive, so it can't stop the browser zooming the whole page.
  // Re-attached each render so it always sees the current window — cheap, and simpler
  // than routing a stale closure through a ref.
  const svgRef = useRef<SVGSVGElement>(null);
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const box = hit.current?.getBoundingClientRect();
      if (!box) return;
      e.preventDefault();
      zoomBy(Math.exp(e.deltaY * 0.01), (e.clientX - box.left) / box.width, (e.clientY - box.top) / box.height);
    };
    // A two-finger gesture on the plot is OURS (pinch to zoom), not the page's. The
    // SVG's `touch-action: pan-y` keeps a one-finger swipe scrolling the page, but it
    // also lets the browser claim two fingers moving vertically as a scroll and cancel
    // the pointers mid-pinch — so pinching only worked once the plot was already zoomed.
    // Non-passive, like the wheel: React's touch handlers can't preventDefault either.
    const onTouch = (e: TouchEvent) => {
      if (e.touches.length >= 2) e.preventDefault();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("touchstart", onTouch, { passive: false });
    el.addEventListener("touchmove", onTouch, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchstart", onTouch);
      el.removeEventListener("touchmove", onTouch);
    };
  });

  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (e.key === "+" || e.key === "=" || e.key === "-" || e.key === "0") {
      e.preventDefault();
      if (e.key === "0") resetView();
      else zoomBy(e.key === "-" ? 1 / ZOOM_STEP : ZOOM_STEP);
      return;
    }
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    setHover((h) => {
      const cur = h ?? hi;
      return Math.max(lo, Math.min(hi, cur + (e.key === "ArrowLeft" ? -1 : 1)));
    });
  };

  const toggleLine = (id: string) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const xLabels = hi < lo ? [] : hi - lo > 1 ? [lo, Math.floor((lo + hi) / 2), hi] : lo === hi ? [lo] : [lo, hi];
  const todayKey = dayKey(today);

  return (
    <div className="hist-plot">
      <div className="hist__controls">
        <select
          className="select select--sm"
          value={metric}
          aria-label={t("history.metricAria")}
          onChange={(e) => {
            setMetric(e.target.value as PlotMetric);
            resetView();
          }}
        >
          {METRICS.map((m) => (
            <option key={m.value} value={m.value}>
              {t(m.label)}
            </option>
          ))}
        </select>
        {hasData && (
          <div className="hist__seg hist-plot__zoom" role="group" aria-label={t("history.zoomAria")}>
            <button type="button" className="hist__segbtn" onClick={() => zoomBy(1 / ZOOM_STEP)} disabled={!zoomed} aria-label={t("history.zoomOut")} title={t("history.zoomOut")}>
              −
            </button>
            <button type="button" className="hist__segbtn" onClick={() => zoomBy(ZOOM_STEP)} aria-label={t("history.zoomIn")} title={t("history.zoomIn")}>
              +
            </button>
            <button type="button" className="hist__segbtn" onClick={resetView} disabled={!zoomed}>
              {t("history.zoomReset")}
            </button>
          </div>
        )}
      </div>

      {(isConf || hasData) && (
        <p className="hist__note">
          {isConf && t("history.confidenceNote")} {hasData && t("history.zoomHint")}
        </p>
      )}

      {!hasData ? (
        <p className="hist__empty">{t(isConf ? "history.noConfidence" : "history.empty")}</p>
      ) : (
        <div className="hist-plot__body">
        <div className="hist-plot__frame">
          <svg
            ref={svgRef}
            className={`hist-plot__svg${zoomed ? " hist-plot__svg--zoomed" : ""}`}
            viewBox={`0 0 ${W} ${H}`}
            role="img"
            aria-label={`${t(METRICS.find((m) => m.value === metric)!.label)} — ${t(
              RANGE_OPTS.find((r) => r.value === range)!.label,
            )}`}
            tabIndex={0}
            onKeyDown={onKey}
            onBlur={() => setHover(null)}
          >
            {/* The plot area — lines and markers are clipped to it while zoomed (padded a
                marker's radius so an edge point isn't cut in half at rest). */}
            <defs>
              <clipPath id={clipId}>
                <rect x={M.left - 6} y={M.top - 6} width={PW + 12} height={PH + 12} />
              </clipPath>
            </defs>

            {/* Recessive grid + y labels. */}
            {ticks.map((tv) => (
              <g key={tv}>
                <line x1={M.left} x2={W - M.right} y1={y(tv)} y2={y(tv)} className="hist-plot__grid" />
                <text x={M.left - 6} y={y(tv)} className="hist-plot__tick" textAnchor="end" dominantBaseline="middle">
                  {fmtTick(tv)}
                </text>
              </g>
            ))}
            {xLabels.map((i) => (
              <text key={keys[i]} x={x(i)} y={H - 8} className="hist-plot__tick" textAnchor={i === lo ? "start" : i === hi ? "end" : "middle"}>
                {keys[i] <= todayKey ? fmtKey(keys[i]) : ""}
              </text>
            ))}

            {/* The daily goal, as a dashed reference line with its label at the right end. */}
            {goal != null && hasData && goal >= v.y0 && goal <= v.y1 && (
              <g className="hist-plot__goal" data-testid="goal-line">
                <line x1={M.left} x2={W - M.right} y1={y(goal)} y2={y(goal)} className="hist-plot__goalline" />
                <text x={W - M.right} y={y(goal) - 4} className="hist-plot__goallabel" textAnchor="end">
                  {t("goals.plotGoal")} {goal}
                </text>
              </g>
            )}

            {/* Crosshair. */}
            {hover != null && (
              <line x1={x(hover)} x2={x(hover)} y1={M.top} y2={M.top + PH} className="hist-plot__cross" />
            )}

            {/* Lines (gaps bridged) + markers. */}
            <g clipPath={`url(#${clipId})`}>
            {shown.map((s) => {
              const pts = s.points
                .map((p, i) => (p.value == null ? null : `${x(i)},${y(p.value)}`))
                .filter(Boolean)
                .join(" ");
              return (
                <g key={s.id}>
                  <polyline
                    points={pts}
                    fill="none"
                    stroke={s.color}
                    strokeWidth={s.width}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                    strokeDasharray={s.dashed ? "5 4" : undefined}
                  />
                  {s.points.map((p, i) =>
                    p.value == null ? null : (
                      <circle
                        key={p.key}
                        cx={x(i)}
                        cy={y(p.value)}
                        r={hover === i ? 5 : 4}
                        fill={s.color}
                        className="hist-plot__dot"
                      />
                    ),
                  )}
                </g>
              );
            })}
            </g>

            {/* Hit layer: the whole plot area, so the pointer aims at a date, not a line. */}
            <rect
              ref={hit}
              x={M.left}
              y={M.top}
              width={PW}
              height={PH}
              fill="transparent"
              className="hist-plot__hit--pan"
              onPointerMove={onPointerMove}
              onPointerDown={onPointerDown}
              onPointerUp={endPointer}
              onPointerCancel={endPointer}
              onPointerLeave={() => {
                if (pointers.current.size === 0) setHover(null);
              }}
            />
          </svg>

          {hover != null && shown.length > 0 && (
            <div
              className="hist-plot__tip"
              style={{ left: `${(x(hover) / W) * 100}%` }}
              data-side={hover > n / 2 ? "left" : "right"}
              role="status"
            >
              <div className="hist-plot__tipdate">{fmtKey(keys[hover], true)}</div>
              {shown
                .slice()
                .reverse()
                .map((s) => (
                  <div key={s.id} className="hist-plot__tiprow">
                    <span className="hist-plot__key" style={{ background: s.color }} />
                    <strong>{fmtVal(s.points[hover]?.value ?? null)}</strong>
                    <span className="hist-plot__tiplabel">{s.label}</span>
                  </div>
                ))}
            </div>
          )}
        </div>

        {/* The line toggles, beside the plot: the legend, made clickable. Overall on top
            (it's the one most people keep), then the levels hardest-first. */}
        {isConf && series.length > 1 && (
          <ul className="hist-plot__toggles" aria-label={t("history.linesAria")}>
            {series
              .slice()
              .reverse()
              .map((s) => {
                const on = !hidden.has(s.id);
                return (
                  <li key={s.id}>
                    <button
                      type="button"
                      className={`hist-plot__toggle${on ? "" : " is-off"}`}
                      aria-pressed={on}
                      onClick={() => toggleLine(s.id)}
                    >
                      <span
                        className={`hist-plot__key${s.dashed ? " hist-plot__key--dashed" : ""}`}
                        style={{ background: s.dashed || !on ? undefined : s.color, borderColor: s.color }}
                      />
                      <span className="ellipsis">{s.label}</span>
                    </button>
                  </li>
                );
              })}
          </ul>
        )}
        </div>
      )}

      {/* Time span under the plot, like a stock chart: short → long. */}
        <div className="hist__seg hist__seg--range" role="group" aria-label={t("history.rangeAria")}>
          {RANGE_OPTS.map((r) => (
            <button
              key={r.value}
              type="button"
              className={`hist__segbtn${range === r.value ? " is-active" : ""}`}
              aria-pressed={range === r.value}
              onClick={() => {
                setRange(r.value);
                resetView();
              }}
            >
              {t(r.label)}
            </button>
          ))}
        </div>

      {/* Every value, reachable without hovering. */}
      {hasData && (
        <table className="hist__sr">
          <thead>
            <tr>
              <th scope="col">{t("history.rangeAria")}</th>
              {series.map((s) => (
                <th key={s.id} scope="col">
                  {s.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {keys.map((k, i) => (
              <tr key={k}>
                <th scope="row">{fmtKey(k, true)}</th>
                {series.map((s) => (
                  <td key={s.id}>{fmtVal(s.points[i]?.value ?? null)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
