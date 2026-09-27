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
import { useMemo, useState, type KeyboardEvent, type PointerEvent } from "react";
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

/** A "nice" axis ceiling ≥ v (1, 2, 5 × 10^k), so gridlines land on round numbers. */
function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

export function HistoryPlot({ history }: { history: ProfileHistory }) {
  const { t, locale } = useI18n();
  const [metric, setMetric] = useState<PlotMetric>("added");
  const [range, setRange] = useState<HistoryRange>("1m");
  const [hover, setHover] = useState<number | null>(null);
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
  const yMax = isConf ? 5 : niceMax(Math.max(0, ...series.flatMap((s) => s.points.map((p) => p.value ?? 0))));
  const ticks = isConf ? [0, 1, 2, 3, 4, 5] : [0, yMax / 2, yMax];

  const x = (i: number) => M.left + (n <= 1 ? PW / 2 : (i * PW) / (n - 1));
  const y = (v: number) => M.top + PH - (v / yMax) * PH;

  const fmtKey = (key: string, long = false) => {
    const d = parseDayKey(key);
    const g = RANGES[range].granularity;
    if (g === "month") return d.toLocaleDateString(locale, { year: long ? "numeric" : undefined, month: "short" });
    return d.toLocaleDateString(locale, { month: "short", day: "numeric", year: long ? "numeric" : undefined });
  };
  const fmtVal = (v: number | null) => (v == null ? "—" : isConf ? v.toFixed(1) : String(Math.round(v)));

  const pickIndex = (e: PointerEvent<SVGRectElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * PW; // → plot units
    setHover(n <= 1 ? 0 : Math.max(0, Math.min(n - 1, Math.round((px / PW) * (n - 1)))));
  };
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    setHover((h) => {
      const cur = h ?? n - 1;
      return Math.max(0, Math.min(n - 1, cur + (e.key === "ArrowLeft" ? -1 : 1)));
    });
  };

  const xLabels = n > 2 ? [0, Math.floor((n - 1) / 2), n - 1] : keys.map((_, i) => i);
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
            setHover(null);
          }}
        >
          {METRICS.map((m) => (
            <option key={m.value} value={m.value}>
              {t(m.label)}
            </option>
          ))}
        </select>
      </div>

      {isConf && <p className="hist__note">{t("history.confidenceNote")}</p>}

      {!hasData ? (
        <p className="hist__empty">{t(isConf ? "history.noConfidence" : "history.empty")}</p>
      ) : (
        <div className="hist-plot__frame">
          <svg
            className="hist-plot__svg"
            viewBox={`0 0 ${W} ${H}`}
            role="img"
            aria-label={`${t(METRICS.find((m) => m.value === metric)!.label)} — ${t(
              RANGE_OPTS.find((r) => r.value === range)!.label,
            )}`}
            tabIndex={0}
            onKeyDown={onKey}
            onBlur={() => setHover(null)}
          >
            {/* Recessive grid + y labels. */}
            {ticks.map((v) => (
              <g key={v}>
                <line x1={M.left} x2={W - M.right} y1={y(v)} y2={y(v)} className="hist-plot__grid" />
                <text x={M.left - 6} y={y(v)} className="hist-plot__tick" textAnchor="end" dominantBaseline="middle">
                  {isConf ? v : Math.round(v)}
                </text>
              </g>
            ))}
            {xLabels.map((i) => (
              <text key={keys[i]} x={x(i)} y={H - 8} className="hist-plot__tick" textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"}>
                {keys[i] <= todayKey ? fmtKey(keys[i]) : ""}
              </text>
            ))}

            {/* Crosshair. */}
            {hover != null && (
              <line x1={x(hover)} x2={x(hover)} y1={M.top} y2={M.top + PH} className="hist-plot__cross" />
            )}

            {/* Lines (gaps bridged) + markers. */}
            {series.map((s) => {
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

            {/* Hit layer: the whole plot area, so the pointer aims at a date, not a line. */}
            <rect
              x={M.left}
              y={M.top}
              width={PW}
              height={PH}
              fill="transparent"
              onPointerMove={pickIndex}
              onPointerDown={pickIndex}
              onPointerLeave={() => setHover(null)}
            />
          </svg>

          {hover != null && (
            <div
              className="hist-plot__tip"
              style={{ left: `${(x(hover) / W) * 100}%` }}
              data-side={hover > n / 2 ? "left" : "right"}
              role="status"
            >
              <div className="hist-plot__tipdate">{fmtKey(keys[hover], true)}</div>
              {series
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
                setHover(null);
              }}
            >
              {t(r.label)}
            </button>
          ))}
        </div>

      {hasData && series.length > 1 && (
        <ul className="hist-plot__legend">
          {series
            .slice()
            .reverse()
            .map((s) => (
              <li key={s.id}>
                <span
                  className={`hist-plot__key${s.dashed ? " hist-plot__key--dashed" : ""}`}
                  style={{ background: s.dashed ? undefined : s.color, borderColor: s.color }}
                />
                {s.label}
              </li>
            ))}
        </ul>
      )}

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
