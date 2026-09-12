// The vocabulary filter model (pure): the empty-is-inert rule on language/usage/POS,
// and the inverted proficiency rule (checking a language auto-checks all its bands, so
// bands only narrow once one is UNchecked).
import { describe, it, expect } from "vitest";
import {
  activeFilterCount,
  allBandsOf,
  dayKey,
  matchesFilters,
  periodRange,
  toggleLang,
  NO_FILTERS,
  type FilterTarget,
} from "@/services/words/filters";

// Zipf ×100: 600 → commonness 1 (very common), 200 → 5 (rare). See difficulty/level.
const word = (over: Partial<FilterTarget> = {}): FilterTarget => ({
  sourceLang: "JA",
  proficiencyBand: null,
  partOfSpeech: ["n"],
  frequency: 600,
  confidenceRating: 0,
  originallyTranslatedDate: new Date().toISOString(),
  lastReviewedDate: null,
  ...over,
});

const LONG_AGO = "2020-01-01T00:00:00.000Z";
const TODAY = dayKey(new Date());
/** A LOCAL instant on a given local day — the boundaries the ranges are about. */
const at = (day: string, h: number, m = 0) => {
  const [y, mo, d] = day.split("-").map(Number);
  return new Date(y, mo - 1, d, h, m).toISOString();
};

describe("matchesFilters", () => {
  it("matches everything when nothing is checked", () => {
    expect(matchesFilters(word({ frequency: null, partOfSpeech: null }), NO_FILTERS)).toBe(true);
  });

  it("narrows by language", () => {
    const f = toggleLang(NO_FILTERS, "JA");
    expect(matchesFilters(word({ sourceLang: "JA" }), f)).toBe(true);
    expect(matchesFilters(word({ sourceLang: "EN" }), f)).toBe(false);
  });

  it("checking a language checks all of its proficiency bands, which then narrow nothing", () => {
    const f = toggleLang(NO_FILTERS, "JA");
    expect(f.bands.JA).toEqual(allBandsOf("JA")); // JLPT N5..N1
    // an unlabelled word (the common case) still shows while every band is checked
    expect(matchesFilters(word({ proficiencyBand: null }), f)).toBe(true);
    expect(matchesFilters(word({ proficiencyBand: 3 }), f)).toBe(true);
  });

  it("unchecking a band narrows to the remaining ones, and drops unlabelled words", () => {
    const f = { ...toggleLang(NO_FILTERS, "JA"), bands: { JA: [1, 2] } };
    expect(matchesFilters(word({ proficiencyBand: 1 }), f)).toBe(true);
    expect(matchesFilters(word({ proficiencyBand: 5 }), f)).toBe(false);
    expect(matchesFilters(word({ proficiencyBand: null }), f)).toBe(false);
  });

  it("unchecking the language hides (forgets) its bands", () => {
    const f = toggleLang(toggleLang(NO_FILTERS, "JA"), "JA");
    expect(f.langs).toEqual([]);
    expect(f.bands.JA).toBeUndefined();
  });

  it("narrows by usage band, excluding words with no frequency", () => {
    const f = { ...NO_FILTERS, usage: [1 as const] };
    expect(matchesFilters(word({ frequency: 600 }), f)).toBe(true);
    expect(matchesFilters(word({ frequency: 200 }), f)).toBe(false);
    expect(matchesFilters(word({ frequency: null }), f)).toBe(false);
  });

  it("narrows by part of speech, excluding words with none", () => {
    const f = { ...NO_FILTERS, pos: ["verb" as const] };
    expect(matchesFilters(word({ partOfSpeech: ["v5k", "vi"] }), f)).toBe(true);
    expect(matchesFilters(word({ partOfSpeech: ["n"] }), f)).toBe(false);
    expect(matchesFilters(word({ partOfSpeech: null }), f)).toBe(false);
  });
});

describe("the moved axes — added / reviewed / confidence (RANGES: wide open = inert)", () => {
  it("narrows by date added", () => {
    const f = { ...NO_FILTERS, added: { from: TODAY, to: TODAY } };
    expect(matchesFilters(word(), f)).toBe(true);
    expect(matchesFilters(word({ originallyTranslatedDate: LONG_AGO }), f)).toBe(false);
  });

  it("narrows by last reviewed, excluding never-reviewed words", () => {
    const f = { ...NO_FILTERS, reviewed: { from: TODAY, to: TODAY } };
    expect(matchesFilters(word({ lastReviewedDate: new Date().toISOString() }), f)).toBe(true);
    expect(matchesFilters(word({ lastReviewedDate: LONG_AGO }), f)).toBe(false);
    expect(matchesFilters(word({ lastReviewedDate: null }), f)).toBe(false);
  });

  it("includes BOTH endpoint days whole, in local time", () => {
    // The ends are calendar days, not instants: a word added at 23:30 on the last day
    // of the span is in it, and one added a minute after midnight on the first is too.
    // (A UTC day boundary would drop one of them for most of the world.)
    const f = { ...NO_FILTERS, added: { from: "2026-03-02", to: "2026-03-04" } };
    expect(matchesFilters(word({ originallyTranslatedDate: at("2026-03-02", 0, 1) }), f)).toBe(true);
    expect(matchesFilters(word({ originallyTranslatedDate: at("2026-03-04", 23, 30) }), f)).toBe(
      true,
    );
    expect(matchesFilters(word({ originallyTranslatedDate: at("2026-03-01", 23, 30) }), f)).toBe(
      false,
    );
    expect(matchesFilters(word({ originallyTranslatedDate: at("2026-03-05", 0, 1) }), f)).toBe(
      false,
    );
  });

  it("takes either end alone — the calendar can leave a span half-open", () => {
    const since = { ...NO_FILTERS, added: { from: "2026-03-02", to: null } };
    expect(matchesFilters(word({ originallyTranslatedDate: at("2026-06-01", 12) }), since)).toBe(
      true,
    );
    expect(matchesFilters(word({ originallyTranslatedDate: at("2026-03-01", 12) }), since)).toBe(
      false,
    );

    const until = { ...NO_FILTERS, added: { from: null, to: "2026-03-02" } };
    expect(matchesFilters(word({ originallyTranslatedDate: at("2026-01-01", 12) }), until)).toBe(
      true,
    );
    expect(matchesFilters(word({ originallyTranslatedDate: at("2026-06-01", 12) }), until)).toBe(
      false,
    );
  });

  it("reads a REVERSED span as the days between, not as nothing", () => {
    // The picker sorts the two clicks, but the model is what a stale or hand-written
    // range hits — and silently matching zero words looks like lost data.
    const f = { ...NO_FILTERS, added: { from: "2026-03-04", to: "2026-03-02" } };
    expect(matchesFilters(word({ originallyTranslatedDate: at("2026-03-03", 12) }), f)).toBe(true);
  });

  it("narrows by confidence range", () => {
    const f = { ...NO_FILTERS, confA: 2, confB: 4 };
    expect(matchesFilters(word({ confidenceRating: 3 }), f)).toBe(true);
    expect(matchesFilters(word({ confidenceRating: 5 }), f)).toBe(false);
    expect(matchesFilters(word({ confidenceRating: 0 }), f)).toBe(false);
  });

  it("lets the thumbs CROSS — bounds are min/max, so an equal 5-5 still matches", () => {
    const crossed = { ...NO_FILTERS, confA: 4, confB: 2 }; // dragged past each other
    expect(matchesFilters(word({ confidenceRating: 3 }), crossed)).toBe(true);
    const equal = { ...NO_FILTERS, confA: 5, confB: 5 };
    expect(matchesFilters(word({ confidenceRating: 5 }), equal)).toBe(true);
    expect(matchesFilters(word({ confidenceRating: 4 }), equal)).toBe(false);
  });
});

describe("activeFilterCount", () => {
  it("is 0 at rest, and a language with all bands checked counts once (the bands are inert)", () => {
    expect(activeFilterCount(NO_FILTERS)).toBe(0);
    expect(activeFilterCount(toggleLang(NO_FILTERS, "JA"))).toBe(1);
  });

  it("counts the band axis once a band is unchecked", () => {
    const f = { ...toggleLang(NO_FILTERS, "JA"), bands: { JA: [1] } };
    expect(activeFilterCount(f)).toBe(2); // language + its narrowed bands
  });

  it("counts the moved axes too — one each for added, reviewed, a closed-in confidence range", () => {
    expect(activeFilterCount({ ...NO_FILTERS, added: periodRange("week") })).toBe(1);
    expect(activeFilterCount({ ...NO_FILTERS, reviewed: { from: null, to: "2026-03-02" } })).toBe(1);
    expect(activeFilterCount({ ...NO_FILTERS, confA: 1, confB: 5 })).toBe(1);
    // the full 0-5 span narrows nothing, however the thumbs are ordered
    expect(activeFilterCount({ ...NO_FILTERS, confA: 5, confB: 0 })).toBe(0);
    // …and an open date span is the resting state, not an axis.
    expect(activeFilterCount({ ...NO_FILTERS, added: periodRange("all") })).toBe(0);
  });
});

describe("periodRange — the calendar's presets", () => {
  it("is the resting span for 'all', and a real one ending today otherwise", () => {
    expect(periodRange("all")).toEqual({ from: null, to: null });
    expect(periodRange("today")).toEqual({ from: TODAY, to: TODAY });
    for (const p of ["week", "month", "year"] as const) {
      const r = periodRange(p);
      expect(r.to).toBe(TODAY);
      expect(r.from! <= TODAY).toBe(true);
    }
  });

  it("selects a word added today under every preset", () => {
    // The presets all END today, so "this week" can never exclude what you just added
    // — the bug an end-less cutoff can't have and a span can.
    const w = word({ originallyTranslatedDate: new Date().toISOString() });
    for (const p of ["today", "week", "month", "year"] as const) {
      expect(matchesFilters(w, { ...NO_FILTERS, added: periodRange(p) })).toBe(true);
    }
  });
});
