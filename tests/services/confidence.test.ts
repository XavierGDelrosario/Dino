// The DISPLAYED confidence (services/confidence.ts) — the client-side mirror of
// display_confidence() in migration 20260735.
//
// These cases encode the PRODUCT decisions, not just the arithmetic: cramming shows
// up and then fades, a mature word decays gently and never falls through the floor,
// and a fresh failure (which record_review signals by wiping the short-term strength
// and dropping peak_confidence) is allowed to read 0.
import { describe, it, expect } from "vitest";
import {
  displayConfidence,
  confidenceFromStability,
  SHORT_HALF_LIFE_HOURS,
  DISPLAY_DECAY_EXPONENT,
  PEAK_FLOOR,
  type ConfidenceInputs,
} from "@/services/confidence";

const T0 = Date.parse("2026-07-22T09:00:00Z");
const HOURS = (n: number) => T0 + n * 3_600_000;
const DAYS = (n: number) => T0 + n * 86_400_000;

/** A word last reviewed at T0 with the given long/short strengths. */
function word(over: Partial<ConfidenceInputs> = {}): ConfidenceInputs {
  return {
    stability: 4,
    lastReviewedDate: new Date(T0).toISOString(),
    originallyTranslatedDate: new Date(T0).toISOString(),
    shortStability: null,
    shortStabilityAt: null,
    peakConfidence: 0,
    ...over,
  };
}

describe("the constants match migration 20260735", () => {
  it("pins the values the SQL uses", () => {
    // If you change these, change display_confidence() + record_review in the same
    // commit — the two runtimes must agree or Lists and Review disagree on screen.
    expect(SHORT_HALF_LIFE_HOURS).toBe(8);
    expect(DISPLAY_DECAY_EXPONENT).toBe(0.35);
    expect(PEAK_FLOOR).toBe(3);
  });

  it("buckets strength the way confidence_from_stability does", () => {
    expect(confidenceFromStability(null)).toBe(0);
    expect(confidenceFromStability(0.9)).toBe(0);
    expect(confidenceFromStability(1)).toBe(1);
    expect(confidenceFromStability(3)).toBe(2);
    expect(confidenceFromStability(7)).toBe(3);
    expect(confidenceFromStability(16)).toBe(4);
    expect(confidenceFromStability(35)).toBe(5);
  });
});

describe("cramming: visible now, gone by morning", () => {
  // The reported behaviour: quizzing a word repeatedly in one sitting used to move
  // the display 0 → 0 → 0 (the cram freeze ate it). The short-term strength is what
  // record_review writes on those frozen passes.
  const crammed = word({ stability: 4, shortStability: 16, shortStabilityAt: new Date(T0).toISOString() });

  it("shows the session's work immediately", () => {
    expect(displayConfidence(crammed, T0)).toBe(4);
  });

  it("has decayed by the next morning", () => {
    // 24h = three half-lives → 16 → 2 days of short-term left.
    expect(displayConfidence(crammed, HOURS(24))).toBe(2);
  });

  it("is essentially gone two days later", () => {
    expect(displayConfidence(crammed, HOURS(48))).toBeLessThanOrEqual(2);
  });

  it("survives a same-evening return", () => {
    expect(displayConfidence(crammed, HOURS(8))).toBeGreaterThanOrEqual(3);
  });
});

describe("long-term decay is gentler than the schedule's", () => {
  const mature = word({ stability: 40, peakConfidence: 5 });

  it("holds 5/5 through the first fortnight", () => {
    expect(displayConfidence(mature, DAYS(7))).toBe(5);
    expect(displayConfidence(mature, DAYS(14))).toBe(5);
  });

  it("eases down as the word goes stale", () => {
    expect(displayConfidence(mature, DAYS(30))).toBe(4);
  });

  it("never falls through the floor once 5 was reached", () => {
    // A year untouched: true recall is ~0, but the shelf must not read as erased.
    expect(displayConfidence(mature, DAYS(365))).toBe(PEAK_FLOOR);
  });

  it("drops below the floor when the word never earned it", () => {
    // Same word, same year away — but it never reached 5/5, so nothing holds it up.
    // It reads 1, not 0: the gentle curve is what keeps a long-abandoned word from
    // presenting as never-seen. Only the floor is withheld.
    const noPeak = word({ stability: 40, peakConfidence: 3 });
    expect(displayConfidence(noPeak, DAYS(365))).toBe(1);
    expect(displayConfidence(noPeak, DAYS(365))).toBeLessThan(PEAK_FLOOR);
  });
});

describe("failures read honestly", () => {
  it("a fresh failure can read 0 — record_review wipes short and voids the peak", () => {
    // What the row looks like right after grade 1 on a word you just aced.
    const failed = word({ stability: 0.5, shortStability: null, peakConfidence: 4 });
    expect(displayConfidence(failed, T0)).toBe(0);
  });

  it("a never-reviewed word is 0", () => {
    expect(displayConfidence(word({ stability: null, lastReviewedDate: null }), T0)).toBe(0);
  });
});

describe("edges", () => {
  it("decays from the save date when a seeded word was never reviewed", () => {
    // The calibration path seeds stability without a review (see review.ts).
    const seeded = word({ stability: 40, lastReviewedDate: null, peakConfidence: 5 });
    expect(displayConfidence(seeded, T0)).toBe(5);
    expect(displayConfidence(seeded, DAYS(30))).toBe(4);
  });

  it("never returns a value outside 0–5", () => {
    const extreme = word({ stability: 3650, shortStability: 1000, shortStabilityAt: new Date(T0).toISOString() });
    expect(displayConfidence(extreme, T0)).toBe(5);
    expect(displayConfidence(word({ stability: 0 }), DAYS(1000))).toBe(0);
  });
});
