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
  CALIBRATION_TARGET,
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
  const PASS = CALIBRATION_TARGET; // known-fraction that passes a band
  const FAIL = 0.5;

  // Walk the search to convergence, feeding each round's known-fraction from `fn`.
  const run = (maxBand: number, fractionFor: (band: number) => number): number => {
    let s: BandSearch = startBandSearch(maxBand);
    for (let guard = 0; guard < 20; guard++) {
      const step = advanceBandSearch(s, fractionFor(s.band));
      if (step.done) return step.level;
      s = step.search;
    }
    throw new Error("did not converge");
  };

  it("starts at the middle band", () => {
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
      const step = advanceBandSearch(s, s.band <= 3 ? PASS : FAIL);
      if (step.done) break;
      s = step.search;
    }
    expect(rounds).toBeLessThanOrEqual(4); // ~log2(5), not 5
  });

  it("treats exactly the target fraction as a pass (≥, not >)", () => {
    // A single-band framework: passing it → level 1, failing → level 1 (floored).
    const passed = advanceBandSearch(startBandSearch(1), PASS);
    expect(passed).toEqual({ done: true, level: 1 });
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
