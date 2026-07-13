// =========================================================
// The vocabulary FILTER MODEL — which of a user's words a set of criteria selects.
//
// Lives in services/ (pure TS, no React) rather than beside the Lists UI because the
// rules are DOMAIN rules, not widget state: they read the proficiency framework, the
// commonness banding, and the POS categories, and they are what a future
// "review my N3 verbs" / "quiz low-confidence words added this week" flow filters on
// (services/review.ts must be able to import this without reaching into components/).
// The FilterMenu component only renders it; the view only sorts and pages.
//
// Two kinds of axis, and they take OPPOSITE resting states — which is the one thing
// to keep straight when adding another:
//
//  * SET axes (language, usage, POS) — a set of checkboxes. EMPTY = INERT: nothing
//    checked means "don't narrow on this", so the resting form shows the whole list.
//  * RANGE axes (added, reviewed, confidence) — a span with a FULL default ("all
//    time", 0–5). WIDE-OPEN = INERT; they narrow as you close them in.
//
// PROFICIENCY is the deliberate hybrid: checking a language auto-checks all of its
// bands, so it's a set that starts FULL. Hence all-checked = inert there, and a word
// with no curated band drops out only once the user actually unchecks a band — which
// keeps the (very common) unlabelled words visible until a level is really asked for.
//
// Attribute axes read fields already on a saved word (services/proficiency,
// /difficulty, /language). No I/O — safe during render.
// =========================================================

import { frequencyCommonness, type LevelValue } from "../difficulty";
import { proficiencyFrameworkFor } from "../proficiency";
import { partOfSpeechCategory, type LangCode, type PosCategory } from "../language";

/** A calendar period (the added/reviewed axes). */
export type DatePeriod = "all" | "today" | "week" | "month" | "year";

/** Confidence is a 0–5 mastery bucket; the range defaults wide open. */
export const CONF_MIN = 0;
export const CONF_MAX = 5;

/** The word-like shape the filters read (a UserWord satisfies it). */
export interface FilterTarget {
  sourceLang: LangCode;
  proficiencyBand: number | null;
  partOfSpeech: string[] | null;
  frequency: number | null;
  confidenceRating: number;
  originallyTranslatedDate: string;
  lastReviewedDate: string | null;
}

/** The state of every axis. Arrays (not Sets) so updates stay plain-immutable. */
export interface WordFilters {
  /** Input languages to keep; empty = all. */
  langs: LangCode[];
  /** Per SELECTED language, the proficiency bands still checked (all of them by default). */
  bands: Partial<Record<LangCode, number[]>>;
  /** Commonness bands to keep (1 = very common … 5 = rare); empty = any. */
  usage: LevelValue[];
  /** Coarse word classes to keep; empty = any. */
  pos: PosCategory[];
  /** Added within this period; "all" = any time. */
  added: DatePeriod;
  /** LAST REVIEWED within this period; "all" = any time (and never-reviewed words stay). */
  reviewed: DatePeriod;
  /**
   * The two confidence thumbs, stored RAW and allowed to CROSS — never clamped
   * against each other. Clamping is what made the range stick when both thumbs
   * landed on the same value (5–5): the moving thumb's update got cancelled, so it
   * couldn't be dragged either way. The effective bounds are simply min/max of the
   * two, so from any equal position a thumb moves freely in both directions.
   */
  confA: number;
  confB: number;
}

export const NO_FILTERS: WordFilters = {
  langs: [],
  bands: {},
  usage: [],
  pos: [],
  added: "all",
  reviewed: "all",
  confA: CONF_MIN,
  confB: CONF_MAX,
};

/** The effective confidence bounds (the thumbs may cross — see confA/confB). */
export function confBounds(f: WordFilters): { lo: number; hi: number } {
  return { lo: Math.min(f.confA, f.confB), hi: Math.max(f.confA, f.confB) };
}

/** Earliest timestamp a period includes ("today" = since midnight, "week" = since
 *  Monday, "month" = since the 1st, "year" = since Jan 1). */
export function periodCutoff(period: DatePeriod): number {
  if (period === "all") return -Infinity;
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  if (period === "week") d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  else if (period === "month") d.setDate(1);
  else if (period === "year") d.setMonth(0, 1);
  return d.getTime();
}

/** All band values of a language's framework (what a freshly-checked language gets). */
export function allBandsOf(lang: LangCode): number[] {
  return proficiencyFrameworkFor(lang)?.bands.map((b) => b.value) ?? [];
}

/** Add/remove `value` in `xs` (immutably) — the checkbox toggle. */
export function toggle<T>(xs: readonly T[], value: T): T[] {
  return xs.includes(value) ? xs.filter((x) => x !== value) : [...xs, value];
}

/**
 * Check/uncheck a language: checking it AUTO-CHECKS every band of its framework
 * (which is what reveals the band row); unchecking drops the bands with it, so
 * re-checking later starts from the full set again.
 */
export function toggleLang(f: WordFilters, lang: LangCode): WordFilters {
  const bands = { ...f.bands };
  if (f.langs.includes(lang)) delete bands[lang];
  else bands[lang] = allBandsOf(lang);
  return { ...f, langs: toggle(f.langs, lang), bands };
}

/** Whether a language's bands narrow anything (all-checked = inert; see the header). */
function bandsNarrow(lang: LangCode, checked: number[] | undefined): boolean {
  if (!checked) return false;
  const all = allBandsOf(lang);
  return all.length > 0 && checked.length < all.length;
}

/**
 * COMPILE the filters into a predicate, resolving everything that depends only on the
 * FILTERS (date cutoffs, confidence bounds, which languages narrow their bands) ONCE
 * — not per word. Callers filter a whole vocabulary with it:
 *
 *     words.filter(makeMatcher(filters))
 *
 * That matters because the pass is not once-per-click: dragging a confidence thumb
 * emits a new `filters` on every pointer event, so a per-word `new Date()` /
 * `bands.map()` / bounds object would allocate a few thousand times per frame on a
 * large vocabulary. PURE — safe during render.
 */
export function makeMatcher(f: WordFilters): (word: FilterTarget) => boolean {
  const langs = new Set(f.langs);
  const usage = new Set(f.usage);
  const pos = new Set(f.pos);
  const addedCut = periodCutoff(f.added);
  const reviewedCut = periodCutoff(f.reviewed);
  const { lo, hi } = confBounds(f);
  // Only the languages whose bands actually narrow (all-checked = inert; see header).
  const narrowingBands = new Map<LangCode, Set<number>>();
  for (const lang of f.langs) {
    const checked = f.bands[lang];
    if (bandsNarrow(lang, checked)) narrowingBands.set(lang, new Set(checked));
  }

  return (word) => {
    if (langs.size > 0 && !langs.has(word.sourceLang)) return false;

    const bands = narrowingBands.get(word.sourceLang);
    if (bands) {
      // Narrowing on level excludes words with no curated band — there is none to match.
      if (word.proficiencyBand == null || !bands.has(word.proficiencyBand)) return false;
    }

    if (usage.size > 0) {
      const commonness = frequencyCommonness(word);
      if (commonness == null || !usage.has(commonness)) return false;
    }

    if (pos.size > 0) {
      const category = partOfSpeechCategory(word.partOfSpeech);
      if (category == null || !pos.has(category)) return false;
    }

    if (Date.parse(word.originallyTranslatedDate) < addedCut) return false;

    // A reviewed-date filter excludes never-reviewed words (they have no date to match).
    if (f.reviewed !== "all") {
      if (word.lastReviewedDate == null) return false;
      if (Date.parse(word.lastReviewedDate) < reviewedCut) return false;
    }

    return word.confidenceRating >= lo && word.confidenceRating <= hi;
  };
}

/** Does this ONE word survive the filters? Convenience over `makeMatcher` — use the
 *  matcher directly when filtering a whole list. PURE. */
export function matchesFilters(word: FilterTarget, f: WordFilters): boolean {
  return makeMatcher(f)(word);
}

/** How many axes are narrowing the list (0 = the filters are resting) — the button badge. */
export function activeFilterCount(f: WordFilters): number {
  const bandAxes = f.langs.filter((l) => bandsNarrow(l, f.bands[l])).length;
  const { lo, hi } = confBounds(f);
  return (
    f.langs.length +
    f.usage.length +
    f.pos.length +
    bandAxes +
    (f.added !== "all" ? 1 : 0) +
    (f.reviewed !== "all" ? 1 : 0) +
    (lo !== CONF_MIN || hi !== CONF_MAX ? 1 : 0)
  );
}
