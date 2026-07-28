// =========================================================
// Reader → AnalyzeData adapter (PURE, tested).
//
// Turns the paragraph reader's per-token knowledge state into the abstract
// AnalyzeData the infographic renders: bar charts for Level (proficiency),
// Frequency, and Confidence, plus a coverage donut (known / new / no-entry).
//
// Counts UNIQUE content words (first occurrence wins) — a vocabulary summary of
// the text, not a token count. Reads only fields already on the Word, so it's a
// safe render-time call, like getProficiency / getDifficulty. Language-neutral:
// the Level chart appears only when the source language has a proficiency
// framework (JA→JLPT, EN→CEFR); everything else works for any language.
// =========================================================

import { isContentPos, type AnalyzedToken, type LangCode } from "../language";
import { getProficiency, proficiencyFrameworkFor } from "../proficiency";
import type { Word } from "../words/repository";
import type { AnalyzeData, InfographicBucket, InfographicSeries } from "./types";

export interface ReaderAnalysisInput {
  tokens: AnalyzedToken[];
  meaningsByWord: Map<string, Word[]>;
  saved: Set<string>;
  confidence: Map<string, number>;
}

export interface ReaderSummary {
  /** Unique content words considered (the infographic denominator). */
  total: number;
  data: AnalyzeData;
}

// Frequency bins over wordfreq Zipf × 100 (HIGHER = more common). Ordered
// common→rare so the chart reads top-down easy→hard; `weight` drives the color.
const FREQ_BINS = [
  { key: "vcommon", label: "Very common", min: 550 },
  { key: "common", label: "Common", min: 450 },
  { key: "mid", label: "Mid", min: 350 },
  { key: "uncommon", label: "Uncommon", min: 250 },
  { key: "rare", label: "Rare", min: -Infinity },
] as const;

function freqBinKey(freq: number): string {
  for (const b of FREQ_BINS) if (freq >= b.min) return b.key;
  return FREQ_BINS[FREQ_BINS.length - 1].key;
}

const clampConf = (n: number) => Math.min(5, Math.max(0, Math.round(n)));

/** Per-bucket tally: total words + how many are already known (saved). */
interface Tally {
  total: number;
  known: number;
}
function bump(m: Map<string, Tally>, key: string, known: boolean): void {
  const e = m.get(key) ?? { total: 0, known: 0 };
  e.total++;
  if (known) e.known++;
  m.set(key, e);
}

/**
 * Aggregate the reader's tokens into an AnalyzeData. See file header.
 * OUTPUT: { total, data }. PURE.
 */
export function summarizeReader(input: ReaderAnalysisInput): ReaderSummary {
  const { tokens, meaningsByWord, saved, confidence } = input;

  const seen = new Set<string>();
  let fresh = 0; // in the dictionary, not yet saved (blue / addable)
  const knownByConf = [0, 0, 0, 0, 0, 0]; // known words by confidence 0..5
  // proficiency label / freq bin key → { total, known } (known = saved in vocab)
  const levelCounts = new Map<string, Tally>();
  const freqCounts = new Map<string, Tally>();
  let sourceLang: LangCode | null = null;

  for (const t of tokens) {
    if (!isContentPos(t.pos) || seen.has(t.text)) continue;
    seen.add(t.text);

    const senses = meaningsByWord.get(t.text) ?? [];
    if (senses.length === 0) continue; // no dictionary entry — counted in `total`, not the pie
    const primary = senses[0];
    if (!sourceLang) sourceLang = primary.sourceLang;

    const savedSenses = senses.filter((s) => saved.has(s.wordId));
    const isKnown = savedSenses.length > 0;
    if (!isKnown) {
      fresh++;
    } else {
      const best = Math.max(...savedSenses.map((s) => confidence.get(s.wordId) ?? 0));
      knownByConf[clampConf(best)]++;
    }

    bump(levelCounts, getProficiency(primary)?.label ?? "—", isKnown);
    bump(freqCounts, primary.frequency == null ? "—" : freqBinKey(primary.frequency), isKnown);
  }

  const total = seen.size;
  const bars: InfographicSeries[] = [];

  // Confidence — the default tab. A "New" row (blue = in-dictionary, not yet saved)
  // sits ABOVE the 0..5 saved-mastery buckets, so the whole learning arc reads in one
  // column: New → 0 (saved, forgotten) → … → 5 (mastered).
  bars.push({
    title: "Confidence",
    kind: "confidence",
    buckets: [
      { key: "new", label: "New", value: fresh },
      ...knownByConf.map((v, i) => ({ key: String(i), label: String(i), value: v })),
    ],
  });

  // Frequency. Display order: unranked "—" pinned to the top, then rare → common,
  // so COMMON sits at the BOTTOM. Weight is common 0 (green) … rare 1 (blue).
  {
    const n = FREQ_BINS.length;
    const ranked: InfographicBucket[] = FREQ_BINS.map((b, i) => {
      const t = freqCounts.get(b.key);
      return {
        key: b.key,
        label: b.label,
        value: t?.total ?? 0,
        known: t?.known ?? 0,
        weight: n <= 1 ? 0.5 : i / (n - 1),
      };
    });
    const dash = freqCounts.get("—");
    const dashBucket: InfographicBucket = { key: "—", label: "—", value: dash?.total ?? 0, known: dash?.known ?? 0, muted: true };
    bars.push({ title: "Frequency", kind: "ordinal", buckets: [dashBucket, ...ranked.reverse()] });
  }

  // Difficulty (proficiency level) — only when the language has a framework AND at
  // least one word actually carries a band. Proficiency wordlists are sparsely
  // ingested, so most texts have every word in "—"; a chart that's all "—" is noise,
  // so hide the tab until there's real band data to show.
  const fw = sourceLang ? proficiencyFrameworkFor(sourceLang) : null;
  const bandedTotal = [...levelCounts].reduce((s, [label, t]) => (label === "—" ? s : s + t.total), 0);
  if (fw && bandedTotal > 0) {
    // Display order: unranked "—" on top, then hardest → easiest, so the EASIEST
    // band sits at the BOTTOM. Weight is easiest 0 (green) … hardest 1 (blue).
    const n = fw.bands.length;
    const ranked: InfographicBucket[] = [...fw.bands]
      .sort((a, b) => b.value - a.value) // hardest first
      .map((b) => {
        const t = levelCounts.get(b.label);
        return {
          key: b.label,
          label: b.label,
          value: t?.total ?? 0,
          known: t?.known ?? 0,
          weight: n <= 1 ? 0.5 : (b.value - 1) / (n - 1),
        };
      });
    const dash = levelCounts.get("—");
    const dashBucket: InfographicBucket = { key: "—", label: "—", value: dash?.total ?? 0, known: dash?.known ?? 0, muted: true };
    bars.push({ title: "Difficulty", kind: "ordinal", buckets: [dashBucket, ...ranked] });
  }

  const knownTotal = knownByConf.reduce((a, b) => a + b, 0);

  // Coverage pie — Known vs New (in-dictionary words only). Words with no dictionary
  // entry are excluded here; they still count toward `total` and show grey in the reader.
  const pie: InfographicSeries = {
    title: "Coverage",
    kind: "coverage",
    buckets: [
      { key: "known", label: "Known", value: knownTotal },
      { key: "new", label: "New", value: fresh },
    ],
  };

  return { total, data: { total, bars, pie } };
}
