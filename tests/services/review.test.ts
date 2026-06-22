import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeUserWord } from "@test/fixtures";

// review.ts is an orchestration module: it reads via userWords.getAllUserWords
// (mocked) and writes via supabase.rpc (the stub). Mock both seams.
const { holder } = vi.hoisted(() => ({ holder: { client: null as unknown as SupabaseStub["client"] } }));
vi.mock("@/config/supabaseClient", () => ({
  supabase: new Proxy({}, { get: (_t, p) => holder.client[p as keyof typeof holder.client] }),
}));
vi.mock("@/services/words/userWords", async (orig) => ({
  ...(await orig<typeof import("@/services/words/userWords")>()),
  getAllUserWords: vi.fn(),
}));

import { createSupabaseStub, type SupabaseStub } from "@test/supabaseStub";
import { getAllUserWords } from "@/services/words/userWords";
import { retrievability, getReviewQueue, recordReview } from "@/services/review";

const DAY = 86_400_000;
const NOW = Date.parse("2026-06-18T00:00:00Z");
const daysAgo = (n: number) => new Date(NOW - n * DAY).toISOString();

let stub: SupabaseStub;
beforeEach(() => {
  stub = createSupabaseStub();
  holder.client = stub.client;
  vi.mocked(getAllUserWords).mockReset();
});

describe("retrievability", () => {
  it("is 0 for a never-reviewed word (no stability) — most urgent", () => {
    expect(retrievability(null, null, NOW)).toBe(0);
    expect(retrievability(null, daysAgo(1), NOW)).toBe(0);
    expect(retrievability(5, null, NOW)).toBe(0);
  });

  it("is ~1 immediately after review and decays toward 0 over time", () => {
    expect(retrievability(5, daysAgo(0), NOW)).toBeCloseTo(1, 5);
    // at Δ = stability, R = e^-1 ≈ 0.368
    expect(retrievability(5, daysAgo(5), NOW)).toBeCloseTo(Math.exp(-1), 5);
    // a stronger word decays slower: same elapsed time → higher R
    expect(retrievability(20, daysAgo(5), NOW)).toBeGreaterThan(
      retrievability(5, daysAgo(5), NOW)
    );
  });
});

describe("getReviewQueue", () => {
  it("returns the N least-confident words, most-forgotten first", async () => {
    vi.mocked(getAllUserWords).mockResolvedValue([
      makeUserWord({ userWordId: "fresh", stability: 100, lastReviewedDate: daysAgo(0) }), // R≈1
      makeUserWord({ userWordId: "new", stability: null, lastReviewedDate: null }), //        R=0
      makeUserWord({ userWordId: "weak", stability: 2, lastReviewedDate: daysAgo(10) }), //   R≈0.007
    ]);

    const queue = await getReviewQueue({ userId: "u", limit: 2, now: NOW });

    expect(queue.map((w) => w.userWordId)).toEqual(["new", "weak"]);
    expect(queue[0]?.retrievability).toBe(0);
    expect(queue[1]?.retrievability).toBeLessThan(0.05);
  });

  it("returns an empty queue for an empty vocabulary", async () => {
    vi.mocked(getAllUserWords).mockResolvedValue([]);
    expect(await getReviewQueue({ userId: "u", limit: 5, now: NOW })).toEqual([]);
  });
});

describe("recordReview", () => {
  it("calls the record_review RPC with the grade and maps the updated row", async () => {
    stub.rpc.mockResolvedValue({
      data: {
        user_word_id: "uw1",
        stability: 3,
        confidence_rating: 1,
        last_reviewed_date: "2026-06-18T00:00:00Z",
      },
      error: null,
    });

    const res = await recordReview({ userWordId: "uw1", grade: 4 });

    expect(stub.rpc).toHaveBeenCalledWith("record_review", {
      p_user_word_id: "uw1",
      p_grade: 4,
    });
    expect(res).toEqual({
      userWordId: "uw1",
      stability: 3,
      confidenceRating: 1,
      lastReviewedDate: "2026-06-18T00:00:00Z",
    });
  });

  it("unwraps a single-row array result from PostgREST", async () => {
    stub.rpc.mockResolvedValue({
      data: [
        {
          user_word_id: "uw2",
          stability: 0.5,
          confidence_rating: 0,
          last_reviewed_date: "2026-06-18T00:00:00Z",
        },
      ],
      error: null,
    });

    const res = await recordReview({ userWordId: "uw2", grade: 1 });
    expect(res.userWordId).toBe("uw2");
    expect(res.stability).toBe(0.5);
  });

  it("throws on an RPC error", async () => {
    stub.rpc.mockResolvedValue({ data: null, error: { message: "nope" } });
    await expect(recordReview({ userWordId: "x", grade: 3 })).rejects.toBeTruthy();
  });
});
