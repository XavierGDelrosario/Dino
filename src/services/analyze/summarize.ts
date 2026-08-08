// Reader → AnalyzeData adapter. PURE.
//
// Turns the reader's per-token knowledge state into the abstract AnalyzeData the
// infographic renders: Level, Frequency and Confidence bars plus a coverage donut.
// `summarizeUserWords` is the second adapter, over a SAVED LIST — same charts, no
// coverage pie (a list is 100% known, so the split says nothing).
//
// Counts UNIQUE content words, first occurrence wins: a vocabulary summary of the text,
// not a token count. Reads only fields already on the Word, so it's safe at render
// time. Language-neutral — the Level chart appears only where the source language has
// a proficiency framework.

import { isContentPos, type AnalyzedToken, type LangCode } from "../language";
import { getProficiency, proficiencyFrameworkFor } from "../proficiency";
import type { Word } from "../words/repository";
import type { UserWord } from "../words/userWords";
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

/** Per-bucket tally. `known` is left UNDEFINED by a caller for whom the split says
 *  nothing (a saved list is 100% known), which drops the overlay from that bar. */
interface Tally {
  total: number;
  known?: number;
}
function bump(m: Map<string, Tally>, key: string, known: boolean): void {
  const e = m.get(key) ?? { total: 0, known: 0 };
  e.total++;
  if (known) e.known = (e.known ?? 0) + 1;
  m.set(key, e);
}

/** Tally one word into a bucket with NO knownness split (see Tally). */
function bumpTotal(m: Map<string, Tally>, key: string): void {
  const e = m.get(key) ?? { total: 0 };
  e.total++;
  m.set(key, e);
}

/** The Frequency bar: unranked "—" pinned to the top, then rare → common, so COMMON
 *  sits at the BOTTOM. Weight runs common 0 (green) … rare 1 (blue). */
function frequencyBar(counts: Map<string, Tally>): InfographicSeries {
  const n = FREQ_BINS.length;
  const ranked: InfographicBucket[] = FREQ_BINS.map((b, i) => ({
    key: b.key,
    label: b.label,
    value: counts.get(b.key)?.total ?? 0,
    known: counts.get(b.key)?.known,
    weight: n <= 1 ? 0.5 : i / (n - 1),
  }));
  const dash = counts.get("—");
  const dashBucket: InfographicBucket = {
    key: "—", label: "—", value: dash?.total ?? 0, known: dash?.known, muted: true,
  };
  return { title: "Frequency", kind: "ordinal", buckets: [dashBucket, ...ranked.reverse()] };
}

/**
 * The Difficulty (proficiency band) bar — only when the language HAS a framework
 * and at least one word actually carries a band. Proficiency wordlists are sparsely
 * ingested, so most texts have every word in "—"; a chart that's all "—" is noise,
 * so the tab stays hidden until there's real band data.
 *
 * Display order: unranked "—" on top, then hardest → easiest, so the EASIEST band
 * sits at the BOTTOM. Weight is easiest 0 (green) … hardest 1 (blue).
 *
 * OUTPUT: the series, or null when there's nothing worth showing.
 */
function difficultyBar(counts: Map<string, Tally>, sourceLang: LangCode | null): InfographicSeries | null {
  const fw = sourceLang ? proficiencyFrameworkFor(sourceLang) : null;
  const banded = [...counts].reduce((s, [label, t]) => (label === "—" ? s : s + t.total), 0);
  if (!fw || banded === 0) return null;
  const n = fw.bands.length;
  const ranked: InfographicBucket[] = [...fw.bands]
    .sort((a, b) => b.value - a.value) // hardest first
    .map((b) => ({
      key: b.label,
      label: b.label,
      value: counts.get(b.label)?.total ?? 0,
      known: counts.get(b.label)?.known,
      weight: n <= 1 ? 0.5 : (b.value - 1) / (n - 1),
    }));
  const dash = counts.get("—");
  const dashBucket: InfographicBucket = {
    key: "—", label: "—", value: dash?.total ?? 0, known: dash?.known, muted: true,
  };
  return { title: "Difficulty", kind: "ordinal", buckets: [dashBucket, ...ranked] };
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

  bars.push(frequencyBar(freqCounts));
  const level = difficultyBar(levelCounts, sourceLang);
  if (level) bars.push(level);

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

/**
 * Aggregate a SAVED LIST (the Lists tab's current, filtered selection) into the
 * same AnalyzeData. Same charts as the reader minus the two things a list can't
 * say anything about:
 *
 *   · NO coverage pie. Every word in a list is already in the vocabulary, so the
 *     known/new split is 100/0 by construction — a pie that always reads the same
 *     is decoration, not information.
 *   · NO "New" confidence row, and no knowledge overlay on the ordinal bars, for
 *     the same reason (Tally.known is left undefined).
 *
 * What's left is the question a list CAN answer: how strong is my recall across
 * these words, and how common/hard are they? Confidence is `confidenceRating`,
 * which userWords.ts already resolves through displayConfidence — the same live
 * value the rows show, never the stored snapshot.
 *
 * MIXED LANGUAGES: the Difficulty chart is per-framework (JLPT bands and CEFR
 * bands are different rulers and must never share an axis), so it is built for the
 * most-represented language only; words in other languages are left out of that
 * ONE chart. Frequency is a normalized Zipf score, so it's cross-language safe.
 *
 * OUTPUT: { total, data }. PURE — reads only fields already on each UserWord.
 */
export function summarizeUserWords(words: readonly UserWord[]): ReaderSummary {
  const byConf = [0, 0, 0, 0, 0, 0];
  const levelCounts = new Map<string, Tally>();
  const freqCounts = new Map<string, Tally>();

  // The dominant source language decides which proficiency ruler the Difficulty
  // chart uses (see MIXED LANGUAGES above).
  const langCounts = new Map<LangCode, number>();
  for (const w of words) langCounts.set(w.sourceLang, (langCounts.get(w.sourceLang) ?? 0) + 1);
  const mainLang = [...langCounts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  for (const w of words) {
    byConf[clampConf(w.confidenceRating)]++;
    bumpTotal(freqCounts, w.frequency == null ? "—" : freqBinKey(w.frequency));
    if (w.sourceLang === mainLang) bumpTotal(levelCounts, getProficiency(w)?.label ?? "—");
  }

  const bars: InfographicSeries[] = [
    {
      title: "Confidence",
      kind: "confidence",
      buckets: byConf.map((v, i) => ({ key: String(i), label: String(i), value: v })),
    },
    frequencyBar(freqCounts),
  ];
  const level = difficultyBar(levelCounts, mainLang);
  if (level) bars.push(level);

  return { total: words.length, data: { total: words.length, bars } };
}
