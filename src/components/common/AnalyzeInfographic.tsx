// =========================================================
// AnalyzeInfographic — an ABSTRACT, reusable text-analysis infographic.
//
// Layout: a coverage PIE (with the total word count beside it) next to ONE bar
// chart at a time, chosen by tab buttons (Confidence / Frequency / Difficulty).
// Ordinal charts (Frequency / Difficulty) get an optional "show knowledge" overlay
// that hatches the KNOWN (saved) portion of each bar.
//
// It owns the PALETTE and nothing else — no data logic, no coupling to the reader.
// Hand-rolled SVG/CSS (no chart lib; CSP-safe), theme-aware. Colors reuse the
// reader's own semantics so bars match the words on screen:
//   confidence → the c0..c5 ramp (red = forgot … green = mastered)
//   coverage   → green (known) · accent (new) · muted (no entry)
//   ordinal    → a single blue ramp, light (easy/common) → dark (hard/rare)
// =========================================================

import { useState } from "react";
import type { AnalyzeData, InfographicBucket, InfographicSeries, SeriesKind } from "../../services/analyze/types";
import { CONFIDENCE_HEX, ordinalColor } from "../../services/analyze/palette";
import "./AnalyzeInfographic.css";

const COVERAGE: Record<string, string> = {
  known: "#3ecb6c",
  new: "var(--accent, #a78bfa)",
  none: "var(--muted, #8a91a0)",
};

function bucketColor(kind: SeriesKind, b: InfographicBucket): string {
  if (b.muted) return "var(--muted, #8a91a0)";
  if (b.key === "new") return COVERAGE.new; // the accent — the coverage "New" slice + the Confidence "New" row
  if (kind === "confidence") return CONFIDENCE_HEX[Number(b.key)] ?? "var(--muted, #8a91a0)";
  if (kind === "coverage") return COVERAGE[b.key] ?? "var(--muted, #8a91a0)";
  return ordinalColor(b.weight ?? 0.5);
}

function Bars({ series, showKnowledge }: { series: InfographicSeries; showKnowledge: boolean }) {
  const buckets = series.buckets.filter((b) => b.value > 0);
  if (buckets.length === 0) return <p className="agx-empty">No data.</p>;
  const max = Math.max(...buckets.map((b) => b.value));
  return (
    <div className="agx-bars">
      {buckets.map((b) => {
        const showK = showKnowledge && b.known != null;
        const fill = bucketColor(series.kind, b);
        return (
          <div className="agx-bar" key={b.key} title={showK ? `${b.label}: ${b.known}/${b.value} known` : `${b.label}: ${b.value}`}>
            <span className="agx-bar__label">{b.label}</span>
            <span className="agx-bar__track">
              <span className="agx-bar__fill" style={{ width: `${(b.value / max) * 100}%`, background: fill }} />
              {showK && b.known! > 0 && (
                <span
                  className="agx-bar__known"
                  // same hue as the bar, mixed toward black → a darker band of the SAME
                  // color; the CSS adds a stripe texture on top (backgroundColor, so it
                  // sits UNDER the stripe background-image).
                  style={{ width: `${(b.known! / max) * 100}%`, backgroundColor: `color-mix(in srgb, ${fill} 48%, #000)` }}
                />
              )}
            </span>
            <span className="agx-bar__val">{showK ? `${b.known}/${b.value}` : b.value}</span>
          </div>
        );
      })}
    </div>
  );
}

function Pie({ series, total }: { series: InfographicSeries; total: number }) {
  const buckets = series.buckets.filter((b) => b.value > 0);
  const sum = buckets.reduce((a, b) => a + b.value, 0);
  if (sum === 0) return null;

  // A FILLED pie via the stroke trick: a circle of radius R with strokeWidth 2R
  // paints from the center out, so stroke-dash slices render as solid wedges.
  const R = 22.5;
  const SW = 45;
  const C = 2 * Math.PI * R;
  let offset = 0;

  return (
    <div className="agx-pie">
      <svg viewBox="0 0 100 100" className="agx-pie__svg" role="img" aria-label={`${series.title}: ${total} words`}>
        {buckets.map((b) => {
          const frac = b.value / sum;
          const seg = frac * C;
          const len = seg;
          const pct = Math.round(frac * 100);
          // slice mid-angle (clockwise from 12 o'clock) → a point inside the wedge
          const mid = ((-90 + ((offset + seg / 2) / C) * 360) * Math.PI) / 180;
          const lx = 50 + 26 * Math.cos(mid);
          const ly = 50 + 26 * Math.sin(mid);
          const node = (
            <g key={b.key}>
              <circle
                cx="50"
                cy="50"
                r={R}
                fill="none"
                stroke={bucketColor(series.kind, b)}
                strokeWidth={SW}
                strokeDasharray={`${len} ${C - len}`}
                strokeDashoffset={-offset}
                transform="rotate(-90 50 50)"
              >
                <title>{`${b.label}: ${b.value} · ${pct}%`}</title>
              </circle>
              {frac >= 0.08 && (
                <text x={lx} y={ly} className="agx-pie__pct" textAnchor="middle" dominantBaseline="central">
                  {pct}%
                </text>
              )}
            </g>
          );
          offset += seg;
          return node;
        })}
      </svg>
      <div className="agx-pie__meta">
        <div className="agx-pie__total">
          <strong>{total}</strong> words
        </div>
        <ul className="agx-legend">
          {buckets.map((b) => (
            <li key={b.key}>
              <span className="agx-legend__sw" style={{ background: bucketColor(series.kind, b) }} />
              <span className="agx-legend__lbl">{b.label}</span>
              <span className="agx-legend__val">{b.value}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** Abstract analysis infographic. Pass any AnalyzeData; the component owns colors. */
export function AnalyzeInfographic({ data, className }: { data: AnalyzeData; className?: string }) {
  const [tab, setTab] = useState<string | null>(null);
  const [showKnowledge, setShowKnowledge] = useState(false);
  const active = data.bars.find((s) => s.title === tab) ?? data.bars[0];
  // Frequency / Difficulty — but only when the data HAS a knowledge split to
  // overlay. A saved list is 100% known by construction and reports no `known`,
  // so the toggle would draw a solid bar and say nothing.
  const canKnowledge =
    active?.kind === "ordinal" && active.buckets.some((b) => b.known != null && b.known < b.value);

  return (
    <div className={`agx${className ? ` ${className}` : ""}`}>
      <div className="agx-body">
        {data.pie && <Pie series={data.pie} total={data.total} />}
        {/* Only the bars change per tab, so the selector sits above the bars, not the pie. */}
        <div className="agx-main">
          <div className="agx-tabs">
            <div className="agx-tabs__btns" role="tablist">
              {data.bars.map((s) => (
                <button
                  key={s.title}
                  type="button"
                  role="tab"
                  aria-selected={s.title === active?.title}
                  className={`agx-tab${s.title === active?.title ? " is-active" : ""}`}
                  onClick={() => setTab(s.title)}
                >
                  {s.title}
                </button>
              ))}
            </div>
            {canKnowledge && (
              <button
                type="button"
                className={`agx-know${showKnowledge ? " is-on" : ""}`}
                aria-pressed={showKnowledge}
                onClick={() => setShowKnowledge((v) => !v)}
                title="Overlay how many of each bar's words you already know"
              >
                {showKnowledge ? "☑" : "☐"} Show knowledge
              </button>
            )}
          </div>
          {active && <Bars series={active} showKnowledge={showKnowledge && canKnowledge} />}
        </div>
      </div>
    </div>
  );
}
