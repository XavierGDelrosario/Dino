import { describe, it, expect, beforeEach, vi } from "vitest";
import { createSupabaseStub, type SupabaseStub } from "@test/supabaseStub";

const { holder } = vi.hoisted(() => ({ holder: { client: null as unknown as SupabaseStub["client"] } }));
vi.mock("@/config/supabaseClient", () => ({
  supabase: new Proxy({}, { get: (_t, p) => holder.client[p as keyof typeof holder.client] }),
}));

import {
  estimateLevel,
  seedStability,
  getUserLevel,
  setUserLevel,
  getUserProficiencyBand,
  setUserProficiencyBand,
  startBandSearch,
  advanceBandSearch,
  resolveLevelMove,
  type BandSearch,
  type CalibrationSample,
} from "@/services/calibration";
import type { LevelValue } from "@/services/difficulty";
import type { ReviewGrade } from "@/services/review";

let stub: SupabaseStub;
beforeEach(() => {
  stub = createSupabaseStub();
  holder.client = stub.client;
});

const s = (difficulty: LevelValue, grade: ReviewGrade): CalibrationSample => ({ difficulty, grade });

describe("estimateLevel", () => {
  it("returns null with no samples", () => {
    expect(estimateLevel([])).toBeNull();
  });

  it("credits the highest contiguous tested level the user clearly recalls", () => {
    // levels 1 & 2 recalled (grade 5), level 3 recalled too → 3
    expect(estimateLevel([s(1, 5), s(2, 5), s(3, 4)])).toBe(3);
  });

  it("stops at the first TESTED level that fails the threshold", () => {
    // 1 pass, 2 pass, 3 fail (both lapsed), 4 pass → stops at 3 → estimate 2.
    expect(estimateLevel([s(1, 5), s(2, 4), s(3, 1), s(3, 2), s(4, 5)])).toBe(2);
  });

  it("skips untested levels rather than failing on them", () => {
    // nothing at level 1; levels 2 & 3 recalled → 3 (the gap at 1 doesn't block)
    expect(estimateLevel([s(2, 4), s(3, 5)])).toBe(3);
  });

  it("requires CLEAR recall (≥ 0.75) to credit a level", () => {
    // level 2: 1 of 2 recalled = 0.5 < 0.75 → fails → estimate stays at level 1
    expect(estimateLevel([s(1, 5), s(2, 5), s(2, 1)])).toBe(1);
  });

  it("returns null when even the lowest tested level fails (true beginner)", () => {
    expect(estimateLevel([s(1, 1), s(1, 2)])).toBeNull();
  });
});

describe("seedStability (conservative cold-start bias)", () => {
  it("returns null when difficulty or level is unknown (cold start)", () => {
    expect(seedStability(null, 3)).toBeNull();
    expect(seedStability(2, null)).toBeNull();
  });

  it("cold-starts words at or above the SHADED level (userLevel − 1)", () => {
    // level 3 → shaded 2; a level-3 word is above the shaded level → null (cold)
    expect(seedStability(3, 3)).toBeNull();
    // a level-2 word sits exactly at the shaded level (gap 0) → modest seed
    expect(seedStability(2, 3)).toBe(1.5);
  });

  it("seeds modestly, deeper-below = a bit stronger, capped", () => {
    // level 5 → shaded 4
    expect(seedStability(4, 5)).toBe(1.5); // gap 0
    expect(seedStability(3, 5)).toBe(3.5); // gap 1
    expect(seedStability(2, 5)).toBe(7.0); // gap 2
    expect(seedStability(1, 5)).toBe(7.0); // gap 3 → capped at 7.0
  });

  it("a level-1 user seeds nothing (shaded level 0 → everything cold)", () => {
    expect(seedStability(1, 1)).toBeNull();
  });
});

describe("adaptive band search (placement quiz)", () => {
  const BATCH = 12;
  // Counts that are DECISIVE (outside BORDERLINE_MARGIN of the 0.8 cutoff), so a
  // round is a verdict rather than a coin-flip: 12/12 = 1.0 passes, 6/12 = 0.5 fails.
  const PASS = BATCH;
  const FAIL = 6;
  // 10/12 = 0.833 — a pass, but within the margin → must be confirmed, not trusted.
  const BORDERLINE = 10;

  // Walk the search to convergence, feeding each round's KNOWN count from `fn`.
  const run = (
    maxBand: number,
    knownFor: (band: number) => number,
    prior: number | null = null,
  ): number => {
    let s: BandSearch = startBandSearch(maxBand, prior);
    for (let guard = 0; guard < 20; guard++) {
      const step = advanceBandSearch(s, knownFor(s.band), BATCH);
      if (step.done) return step.level;
      s = step.search;
    }
    throw new Error("did not converge");
  };

  it("starts at the middle band when there's no prior", () => {
    expect(startBandSearch(5).band).toBe(3);
    expect(startBandSearch(6).band).toBe(3);
    expect(startBandSearch(1).band).toBe(1);
  });

  it("a user who passes every band lands at the hardest", () => {
    expect(run(5, () => PASS)).toBe(5);
  });

  it("a user who fails every band floors at level 1 (never 0)", () => {
    expect(run(5, () => FAIL)).toBe(1);
  });

  it("converges on the hardest band passed (knows ≤ N, fails above)", () => {
    // Knows bands 1..3 (N5..N3), fails 4..5 → level 3.
    expect(run(5, (b) => (b <= 3 ? PASS : FAIL))).toBe(3);
    // Knows only band 1 → level 1.
    expect(run(5, (b) => (b <= 1 ? PASS : FAIL))).toBe(1);
    // Knows 1..4, fails only the hardest → level 4.
    expect(run(5, (b) => (b <= 4 ? PASS : FAIL))).toBe(4);
  });

  it("converges in a few rounds (binary search, not linear)", () => {
    let rounds = 0;
    let s = startBandSearch(5);
    for (;;) {
      rounds++;
      const step = advanceBandSearch(s, s.band <= 3 ? PASS : FAIL, BATCH);
      if (step.done) break;
      s = step.search;
    }
    expect(rounds).toBeLessThanOrEqual(4); // ~log2(5), not 5
  });

  it("treats exactly the target fraction as a pass (≥, not >) once confirmed", () => {
    // Exactly at the cutoff (8/10 = CALIBRATION_TARGET) is BORDERLINE by definition →
    // one confirming round at the same band, then the pooled sample (still exactly at
    // the cutoff) passes.
    const s = startBandSearch(1);
    const first = advanceBandSearch(s, 8, 10);
    expect(first).toEqual({ done: false, search: { ...s, pooled: { known: 8, total: 10 } } });
    if (first.done) throw new Error("unreachable");
    expect(advanceBandSearch(first.search, 8, 10)).toEqual({ done: true, level: 1 });
  });

  // ── The anti-swing behavior (a small sample must not move a whole level) ──

  it("re-tests a BORDERLINE band once and decides on the POOLED sample", () => {
    const s = startBandSearch(5);          // band 3
    const first = advanceBandSearch(s, BORDERLINE, BATCH); // .833 — too close to call
    if (first.done) throw new Error("a borderline batch must not decide the band");
    expect(first.search.band).toBe(3);     // same band again
    expect(first.search.pooled).toEqual({ known: BORDERLINE, total: BATCH });

    // The confirming batch goes badly (6/12) → pooled 16/24 = .67 → the band FAILS,
    // where the first batch alone would have passed it.
    const second = advanceBandSearch(first.search, FAIL, BATCH);
    if (second.done) throw new Error("expected the search to continue below band 3");
    expect(second.search.band).toBeLessThan(3);
    expect(second.search.best).toBe(0);    // band 3 was never credited
    expect(second.search.pooled).toBeUndefined(); // pooled evidence doesn't leak bands
  });

  it("confirms a band at most ONCE (a second borderline batch decides it)", () => {
    const s = startBandSearch(5);
    const first = advanceBandSearch(s, BORDERLINE, BATCH);
    if (first.done) throw new Error("unreachable");
    const second = advanceBandSearch(first.search, BORDERLINE, BATCH);
    if (second.done) throw new Error("unreachable"); // 20/24 = .833 → passes, searches on
    expect(second.search.band).toBeGreaterThan(3);   // moved on, did NOT re-test again
  });

  it("with a PRIOR, the search spans only prior ± 1 and starts at the prior", () => {
    const s = startBandSearch(5, 3);
    expect(s).toMatchObject({ lo: 2, hi: 4, band: 3, prior: 3 });
    // Clamped at the ends of the framework.
    expect(startBandSearch(5, 1)).toMatchObject({ lo: 1, hi: 2, band: 1 });
    expect(startBandSearch(5, 5)).toMatchObject({ lo: 4, hi: 5, band: 5 });
  });

  it("a re-calibration can move at most ONE band, up or down", () => {
    // Aces everything → +1 (not straight to 5).
    expect(run(5, () => PASS, 2)).toBe(3);
    // Fails everything, including a band below the prior → −1 (not down to 1).
    expect(run(5, () => FAIL, 4)).toBe(3);
    // Confirms the prior → unchanged.
    expect(run(5, (b) => (b <= 3 ? PASS : FAIL), 3)).toBe(3);
  });
});

describe("resolveLevelMove (hysteresis)", () => {
  it("clamps a measured level to within one band of the prior", () => {
    expect(resolveLevelMove(5, 2)).toBe(3); // a 3-band jump becomes +1
    expect(resolveLevelMove(1, 4)).toBe(3); // a 3-band drop becomes −1
    expect(resolveLevelMove(3, 3)).toBe(3); // confirmed
  });

  it("a first calibration (no prior) is unclamped, within 1..5", () => {
    expect(resolveLevelMove(5, null)).toBe(5);
    expect(resolveLevelMove(1, null)).toBe(1);
    expect(resolveLevelMove(9, null)).toBe(5);
  });

  it("crediting NOTHING steps one band down from the prior, never to zero", () => {
    expect(resolveLevelMove(0, 3)).toBe(2);
    expect(resolveLevelMove(0, 1)).toBe(1); // floored
    expect(resolveLevelMove(0, null)).toBe(1);
  });
});

describe("getUserLevel / setUserLevel", () => {
  it("reads the stored level", async () => {
    stub.queueFrom("users", { data: { level: 3 }, error: null });
    expect(await getUserLevel("u")).toBe(3);
  });

  it("returns null when the user has no level yet", async () => {
    stub.queueFrom("users", { data: { level: null }, error: null });
    expect(await getUserLevel("u")).toBeNull();
  });

  it("writes the level via an own-row update", async () => {
    stub.queueFrom("users", { data: null, error: null });
    await setUserLevel("u", 4);
    const updates = stub.callsFor("users", "update");
    expect(updates[updates.length - 1]?.args[0]).toEqual({ level: 4 });
  });

  it("throws a ServiceError on a DB error", async () => {
    stub.queueFrom("users", { data: null, error: { message: "nope" } });
    await expect(getUserLevel("u")).rejects.toBeTruthy();
  });
});

describe("getUserProficiencyBand / setUserProficiencyBand (the SEPARATE proficiency axis)", () => {
  it("reads the stored band", async () => {
    stub.queueFrom("users", { data: { proficiency_band: 3 }, error: null });
    expect(await getUserProficiencyBand("u")).toBe(3);
  });

  it("returns null when never calibrated", async () => {
    stub.queueFrom("users", { data: { proficiency_band: null }, error: null });
    expect(await getUserProficiencyBand("u")).toBeNull();
  });

  it("writes the band to its OWN column (not `level`)", async () => {
    stub.queueFrom("users", { data: null, error: null });
    await setUserProficiencyBand("u", 4);
    const updates = stub.callsFor("users", "update");
    expect(updates[updates.length - 1]?.args[0]).toEqual({ proficiency_band: 4 });
  });
});
