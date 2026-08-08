// =========================================================
// Shared analyze palette — the color ramps used by the AnalyzeInfographic (and any
// future analyze surface, e.g. the Media tab). Kept out of the component so the same
// colors can be reused without duplicating hex values.
//
//   confidence → red (forgot) … green (mastered), 0..5
//   ordinal    → green (common / easy) … blue (rare / hard), weight 0..1
// =========================================================

/** Confidence ramp 0..5 (mirrors translate.css .tok--c0..c5). */
export const CONFIDENCE_HEX = ["#ff6b6b", "#ff9f5a", "#ffd166", "#c9d65a", "#7fce6f", "#3ecb6c"];

// Ordinal ramp endpoints: green (weight 0 = common / easy) → blue (weight 1 = rare / hard).
const ORD_COMMON = [0x35, 0xc0, 0x6d];
const ORD_RARE = [0x2b, 0x5f, 0xc4];

/** A color along the green→blue ordinal ramp for weight 0..1 (clamped). */
export function ordinalColor(weight: number): string {
  const w = Math.min(1, Math.max(0, weight));
  const [r, g, b] = ORD_COMMON.map((c, i) => Math.round(c + (ORD_RARE[i] - c) * w));
  return `rgb(${r}, ${g}, ${b})`;
}
