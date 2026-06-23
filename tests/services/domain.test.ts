import { describe, it, expect, vi } from "vitest";

vi.mock("@/services/embeddings", () => ({ relatedWords: vi.fn() }));

import { relatedWords, type RelatedWord } from "@/services/embeddings";
import { rankDomainCandidates, expandDomain } from "@/services/domain";

// freq → difficulty via the real ZIPF_BINS (≥500→1, ≥450→2, ≥400→3, ≥300→4, else 5)
const r = (entryId: string, frequency: number | null, distance: number): RelatedWord => ({
  entryId,
  writing: entryId,
  gloss: `gloss of ${entryId}`,
  frequency,
  distance,
});

describe("rankDomainCandidates", () => {
  it("pools across seeds, ranks domain-central (higher affinity) first, keeps min distance", () => {
    const perSeed = [
      [r("X", 510, 0.2), r("Y", 510, 0.1)], // seed A
      [r("X", 510, 0.15), r("Z", 510, 0.3)], // seed B — X appears again
    ];
    const ranked = rankDomainCandidates(perSeed, ["A", "B"], 1, 10);
    expect(ranked[0].entryId).toBe("X");
    expect(ranked[0].affinity).toBe(2); // near both seeds
    expect(ranked[0].distance).toBeCloseTo(0.15); // min of 0.2 / 0.15
    expect(ranked.map((c) => c.entryId)).toEqual(["X", "Y", "Z"]); // then aff-1 by distance
  });

  it("excludes the seed words themselves and null-writing rows", () => {
    const perSeed = [[
      r("A", 510, 0.1), // A is a seed → excluded
      r("X", 510, 0.2),
      { entryId: "N", writing: null, gloss: null, frequency: 510, distance: 0.1 } as RelatedWord,
    ]];
    expect(rankDomainCandidates(perSeed, ["A"], 1, 10).map((c) => c.entryId)).toEqual(["X"]);
  });

  it("filters to ±1 of the user's level and drops unknown difficulty", () => {
    const perSeed = [[
      r("L1", 510, 0.1), r("L3", 410, 0.1), r("L4", 350, 0.1), r("L5", 200, 0.1), r("UNK", null, 0.1),
    ]];
    // level 2 → keep difficulties 1..3
    expect(rankDomainCandidates(perSeed, [], 2, 10).map((c) => c.entryId).sort()).toEqual(["L1", "L3"]);
  });

  it("skips the level filter when the user has no level", () => {
    const perSeed = [[r("L1", 510, 0.1), r("L5", 200, 0.2)]];
    expect(rankDomainCandidates(perSeed, [], null, 10).map((c) => c.entryId)).toEqual(["L1", "L5"]);
  });

  it("respects the limit", () => {
    const perSeed = [[r("A", 510, 0.1), r("B", 510, 0.2), r("C", 510, 0.3)]];
    expect(rankDomainCandidates(perSeed, [], 1, 2).map((c) => c.entryId)).toEqual(["A", "B"]);
  });
});

describe("expandDomain", () => {
  it("calls related_words per unique seed and returns the ranked pool", async () => {
    vi.mocked(relatedWords).mockImplementation(async (params) =>
      params.entryId === "A" ? [r("X", 510, 0.2)] : [r("X", 510, 0.1), r("Y", 510, 0.3)],
    );
    const out = await expandDomain({ seedEntryIds: ["A", "B", "A"], userLevel: 1 });
    expect(vi.mocked(relatedWords)).toHaveBeenCalledTimes(2); // de-duped seeds
    expect(out[0].entryId).toBe("X"); // affinity 2
    expect(out.map((c) => c.entryId)).toEqual(["X", "Y"]);
  });

  it("returns [] for no seeds and survives a per-seed failure", async () => {
    expect(await expandDomain({ seedEntryIds: [], userLevel: 1 })).toEqual([]);
    vi.mocked(relatedWords).mockImplementation(async () => {
      throw new Error("down");
    });
    expect(await expandDomain({ seedEntryIds: ["A"], userLevel: 1 })).toEqual([]); // non-fatal
  });
});
