// The vocabulary FILTER MODEL — which of a user's words a set of criteria selects.
//
// In services/ rather than beside the Lists UI because these are DOMAIN rules, not
// widget state: a future "review my N3 verbs" flow filters on them, so services/review
// must be able to import this without reaching into components/. FilterMenu only
// renders it; the view only sorts and pages.
//
// Two kinds of axis, with OPPOSITE resting states — the thing to keep straight when
// adding another:
//  * SET axes (language, usage, POS) — checkboxes. EMPTY = INERT.
//  * RANGE axes (added, reviewed, confidence) — a span with a full default.
//    WIDE-OPEN = INERT; they narrow as you close them in.
//
// PROFICIENCY is the deliberate hybrid: checking a language auto-checks all its bands,
// so it's a set that starts FULL and all-checked is inert. A word with no curated band
// drops out only once the user unchecks a band, keeping the (very common) unlabelled
// words visible until a level is really asked for.
//
// No I/O — safe during render.

import { frequencyCommonness, type LevelValue } from "../difficulty";
import { proficiencyFrameworkFor } from "../proficiency";
import { partOfSpeechCategory, type LangCode, type PosCategory } from "../language";

/** A calendar period (the added/reviewed axes). */
export type DatePeriod = "all" | "today" | "week" | "month" | "year";

/** Confidence is a 0–5 mastery bucket; the range defaults wide open. */
export const CONF_MIN = 0;
export const CONF_MAX = 5;

/** Pseudo-band for words with NO curated level (the "—" checkbox). Real bands are ≥ 1,
 *  so 0 is a safe sentinel that participates in the band set like any other. */
export const NO_BAND = 0;

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
  /** The two confidence thumbs, stored RAW and allowed to CROSS — never clamped against
   *  each other. Clamping made the range stick when both landed on the same value: the
   *  moving thumb's update got cancelled, so it couldn't be dragged either way. The
   *  effective bounds are min/max of the two. */
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

/** A framework's band values plus the "—" no-level band — what a freshly-checked
 *  language gets. */
export function allBandsOf(lang: LangCode): number[] {
  const bands = proficiencyFrameworkFor(lang)?.bands.map((b) => b.value);
  return bands ? [...bands, NO_BAND] : [];
}

/** Add/remove `value` in `xs` (immutably) — the checkbox toggle. */
export function toggle<T>(xs: readonly T[], value: T): T[] {
  return xs.includes(value) ? xs.filter((x) => x !== value) : [...xs, value];
}

/** Checking a language AUTO-CHECKS every band of its framework (which is what reveals
 *  the band row); unchecking drops them, so re-checking starts from the full set. */
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
 * COMPILE the filters into a predicate — `words.filter(makeMatcher(filters))` —
 * resolving everything that depends only on the FILTERS once, not per word. That
 * matters because the pass isn't once-per-click: dragging a confidence thumb emits new
 * filters on every pointer event, so a per-word `new Date()` or bounds object would
 * allocate thousands of times per frame on a large vocabulary. PURE.
 */
export function makeMatcher(f: WordFilters): (word: FilterTarget) => boolean {
  const langs = new Set(f.langs);
  const usage = new Set(f.usage);
  const pos = new Set(f.pos);
  const addedCut = periodCutoff(f.added);
  const reviewedCut = periodCutoff(f.reviewed);
  const { lo, hi } = confBounds(f);
  // Only languages whose bands actually narrow (all-checked = inert; see header).
  const narrowingBands = new Map<LangCode, Set<number>>();
  for (const lang of f.langs) {
    const checked = f.bands[lang];
    if (bandsNarrow(lang, checked)) narrowingBands.set(lang, new Set(checked));
  }

  return (word) => {
    if (langs.size > 0 && !langs.has(word.sourceLang)) return false;

    const bands = narrowingBands.get(word.sourceLang);
    // A word with no curated band maps to the "—" pseudo-band, so it survives while
    // "—" is checked (the default) and drops only when the user unchecks it.
    if (bands && !bands.has(word.proficiencyBand ?? NO_BAND)) return false;

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

/** Does this ONE word survive? Use `makeMatcher` directly for a whole list. PURE. */
export function matchesFilters(word: FilterTarget, f: WordFilters): boolean {
  return makeMatcher(f)(word);
}

/** How many axes are narrowing the list (0 = resting) — the button badge. */
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
