// =========================================================
// Abstract data shape for the analyze infographic (bar charts + a pie/donut).
//
// Deliberately UI-AGNOSTIC and reusable: any surface (the paragraph reader, a
// future article-library screen, the extension side panel) builds an AnalyzeData
// and hands it to <AnalyzeInfographic>. No colors live here — the component owns
// the palette, keyed off each series' `kind` (so the same data renders identically
// wherever it's shown). See services/analyze/summarize.ts for the reader adapter.
// =========================================================

/**
 * How a series should be colored:
 *   ordinal    — a ranked scale (levels, frequency); colored light→dark by `weight`.
 *   confidence — the 0..5 recall ramp (red = forgot … green = mastered), keyed "0".."5".
 *   coverage   — knowledge state (known / new / no-entry), keyed by bucket key.
 */
export type SeriesKind = "ordinal" | "confidence" | "coverage";

export interface InfographicBucket {
  /** Stable key; also selects the color for confidence/coverage series. */
  key: string;
  /** Display label (e.g. "N1", "3", "Common", "New"). */
  label: string;
  /** Count. */
  value: number;
  /** ORDINAL series only: 0 = light (easy/common) … 1 = dark (hard/rare). */
  weight?: number;
  /** Force the muted/neutral color (e.g. an unranked "—" bucket). */
  muted?: boolean;
  /**
   * How many of this bucket's words are already KNOWN (saved). Drives the optional
   * "show knowledge" overlay on ordinal charts (Frequency / Difficulty). ≤ value.
   */
  known?: number;
}

export interface InfographicSeries {
  title: string;
  kind: SeriesKind;
  /** Display order is preserved; the renderer drops buckets whose value is 0. */
  buckets: InfographicBucket[];
}

export interface AnalyzeData {
  /** Headline denominator (e.g. content words analyzed). */
  total: number;
  /** One horizontal bar chart per series (Levels, Frequency, Confidence, …). */
  bars: InfographicSeries[];
  /** Optional parts-of-whole donut (the coverage split). */
  pie?: InfographicSeries;
}
