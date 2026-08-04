// =========================================================
// Article word list — the in-depth summary's vocabulary table (PURE, tested).
//
// Turns the reader's per-token state into a list of the UNIQUE, dictionary-REGISTERED
// content words in a text (words with no entry are dropped — the summary is about
// learnable vocabulary). Deduped by the primary sense's word id, so conjugations
// (行った / 行きます) collapse to one 行く row while split homographs stay distinct.
//
// Also owns the SORT / FILTER / COVERAGE helpers the list UI drives — including the
// "recommended" order (common + easy first), which maximizes coverage gained per
// word learned: the fastest route to the ~95%-known comprehension threshold.
// =========================================================

import { isContentPos } from "../language";
import { getProficiency } from "../proficiency";
import { getDifficulty } from "../difficulty";
import type { Word } from "../words/repository";
import type { ReaderAnalysisInput } from "./summarize";
import { orderSensesByContextReading } from "./senseOrder";

export interface ArticleWord {
  /** Dictionary headword (primary sense input). */
  headword: string;
  reading: string | null;
  /** Primary sense (its resolved meaning is `translation`). */
  primary: Word;
  /** All senses, primary first — for the add button + quiz cards. */
  senses: Word[];
  frequency: number | null;
  /** Proficiency band label + numeric band (1 = easiest), or null if unranked. */
  level: { label: string; band: number } | null;
  /** 1..5 difficulty (curated override or frequency-binned), null if unrated. */
  difficulty: number | null;
  /** How many times the word appears in THIS article (content tokens for its lemma). */
  occurrences: number;
  status: "new" | "known";
  /** Live confidence 0..5 (0 for a new word). */
  confidence: number;
}

const clampConf = (n: number) => Math.min(5, Math.max(0, Math.round(n)));

/**
 * Unique registered content words in the analyzed text. PURE.
 * OUTPUT: one ArticleWord per distinct dictionary word, first-appearance order.
 */
export function articleWordList(input: ReaderAnalysisInput): ArticleWord[] {
  const { tokens, meaningsByWord, saved, confidence } = input;
  const byWordId = new Map<string, ArticleWord>();

  for (const t of tokens) {
    if (!isContentPos(t.pos)) continue;
    // Lead with the reading the analyzer gave this token (see analyze/senseOrder),
    // so the row's primary — and the quiz card built from it — matches the furigana
    // the reader displayed. The dedupe below keys on the resulting primary's wordId;
    // in practice IPADIC returns one fixed reading per surface, so the same word
    // still collapses to one row rather than splitting per occurrence.
    const senses = orderSensesByContextReading(meaningsByWord.get(t.text) ?? [], t.reading);
    if (senses.length === 0) continue; // no dictionary entry — disregard
    const primary = senses[0];

    // Already seen this dictionary word → just tally another occurrence.
    const existing = byWordId.get(primary.wordId);
    if (existing) {
      existing.occurrences++;
      continue;
    }

    const savedSenses = senses.filter((s) => saved.has(s.wordId));
    const isKnown = savedSenses.length > 0;
    const conf = isKnown ? Math.max(...savedSenses.map((s) => confidence.get(s.wordId) ?? 0)) : 0;
    const prof = getProficiency(primary);

    byWordId.set(primary.wordId, {
      headword: primary.input,
      reading: primary.inputReading,
      primary,
      senses,
      frequency: primary.frequency ?? null,
      level: prof ? { label: prof.label, band: prof.band } : null,
      difficulty: getDifficulty(primary).level,
      occurrences: 1,
      status: isKnown ? "known" : "new",
      confidence: clampConf(conf),
    });
  }

  return [...byWordId.values()];
}

/** The learn-priority order + the four directional axes. */
export type SortAxis = "recommended" | "common" | "confident" | "difficult" | "occurrences";
/** "least" = ascending (the default face of every axis); "most" = the flipped face. */
export type SortDir = "least" | "most";
export type StatusFilter = "all" | "new" | "known";

const corpusOf = (w: ArticleWord) => w.frequency ?? -Infinity; // unranked = least common

/**
 * Sort a copy of the rows. `recommended` is a fixed learn order (ignores `dir`);
 * the four axes flip between least→most on `dir`. Unrated difficulty always sinks
 * to the bottom (never "most/least difficult"). PURE.
 */
export function sortWords(rows: ArticleWord[], axis: SortAxis, dir: SortDir = "least"): ArticleWord[] {
  const by = [...rows];
  const sign = dir === "most" ? -1 : 1; // ascending (least) by default
  const asc = (val: (w: ArticleWord) => number) => (a: ArticleWord, b: ArticleWord) =>
    (val(a) - val(b)) * sign;

  switch (axis) {
    case "common":
      return by.sort(asc(corpusOf));
    case "confident":
      return by.sort(asc((w) => w.confidence));
    case "occurrences":
      return by.sort(asc((w) => w.occurrences));
    case "difficult":
      // Nulls (unrated) last regardless of direction — they belong to neither end.
      return by.sort((a, b) => {
        if (a.difficulty == null) return b.difficulty == null ? 0 : 1;
        if (b.difficulty == null) return -1;
        return (a.difficulty - b.difficulty) * sign;
      });
    case "recommended":
    default:
      // What to study for THIS text: least-known first (so a frequent word you're
      // already confident in sinks), then most-frequent-in-article, then common.
      // Confidence-driven, so it re-orders live as you learn/quiz words.
      return by.sort(
        (a, b) => a.confidence - b.confidence || b.occurrences - a.occurrences || corpusOf(b) - corpusOf(a),
      );
  }
}

/**
 * The article's quiz set, capped at `cap`: NEW words first (recommended order),
 * then a top-up of the article's SAVED words in least-confident order. PURE.
 *
 * The top-up is the point: the quiz used to be new-words-only, so it emptied itself
 * — quizzing the new words SAVES them, which flips them to "known" and shrank the
 * set on every pass until the button vanished mid-study. An article you've already
 * saved every word of is still the natural thing to review, so the set falls back
 * to "the words in THIS article you hold least well" rather than disappearing.
 */
export function quizWords(rows: ArticleWord[], cap: number): ArticleWord[] {
  const fresh = sortWords(rows.filter((r) => r.status === "new"), "recommended");
  const known = sortWords(rows.filter((r) => r.status === "known"), "recommended");
  return [...fresh, ...known].slice(0, Math.max(0, cap));
}

/** Apply the status filter (level filtering is done in the component from present bands). */
export function filterByStatus(rows: ArticleWord[], status: StatusFilter): ArticleWord[] {
  return status === "all" ? rows : rows.filter((r) => r.status === status);
}

export interface Coverage {
  known: number;
  total: number;
  /** Fraction known 0..1 (1 when there are no registered words). */
  pct: number;
}

/** Known vs total registered words. PURE. */
export function coverageOf(rows: ArticleWord[]): Coverage {
  const total = rows.length;
  const known = rows.reduce((n, r) => n + (r.status === "known" ? 1 : 0), 0);
  return { known, total, pct: total ? known / total : 1 };
}

/**
 * How many NEW words must be learned to reach `target` coverage (default 0.95).
 * Order-independent as a COUNT (each learned word is +1 known); the recommended
 * sort decides WHICH words those are (the highest-value ones). PURE.
 */
export function wordsToTarget(rows: ArticleWord[], target = 0.95): number {
  const total = rows.length;
  if (total === 0) return 0;
  const known = rows.reduce((n, r) => n + (r.status === "known" ? 1 : 0), 0);
  if (known / total >= target) return 0;
  const need = Math.ceil(target * total) - known;
  return Math.max(0, Math.min(need, total - known));
}
