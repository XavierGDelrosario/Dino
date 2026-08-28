// =========================================================
// Shared analyze palette — the color ramps used by the AnalyzeInfographic (and any
// future analyze surface, e.g. the Media tab). Kept out of the component so the same
// colors can be reused without duplicating hex values.
//
//   confidence → red (forgot) … green (mastered), 0..5
//   ordinal    → green (common / easy) … blue (rare / hard), weight 0..1
//
// These are CSS custom properties, not hex literals, and that is the whole point:
// both ramps have to change between the light and dark themes (the dark
// confidence set is far too pale to read on a light background), and a chart that
// kept its own private copy of the colors would contradict the very words it is
// charting — the reader paints tokens from the SAME --conf-* variables. The theme
// swaps the variables; nothing here needs to know which theme is on.
// =========================================================

/** Confidence ramp 0..5 (the same tokens the reader's .tok--c0..c5 use). */
export const CONFIDENCE_COLORS = [
  "var(--conf-0)",
  "var(--conf-1)",
  "var(--conf-2)",
  "var(--conf-3)",
  "var(--conf-4)",
  "var(--conf-5)",
];

/**
 * A color along the ordinal ramp for weight 0..1 (clamped): --ord-common (weight 0
 * = common / easy) → --ord-rare (weight 1 = rare / hard).
 *
 * Interpolated by `color-mix` rather than by arithmetic here, because the endpoints
 * are theme variables — their values aren't known to JS, only to the browser.
 */
export function ordinalColor(weight: number): string {
  const w = Math.min(1, Math.max(0, weight));
  const pct = Math.round(w * 1000) / 10; // 0.1% precision; avoids float noise in the string
  return `color-mix(in srgb, var(--ord-rare) ${pct}%, var(--ord-common))`;
}
