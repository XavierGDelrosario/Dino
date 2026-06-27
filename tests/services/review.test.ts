import { describe, it, expect, vi, beforeEach } from "vitest";

// review.ts reads the queue via the review_queue RPC (ranking + LIMIT now run in
// SQL) and writes via record_review — both through supabase.rpc (the stub).
const { holder } = vi.hoisted(() => ({ holder: { client: null as unknown as SupabaseStub["client"] } }));
vi.mock("@/config/supabaseClient", () => ({
  supabase: new Proxy({}, { get: (_t, p) => holder.client[p as keyof typeof holder.client] }),
}));

import { createSupabaseStub, type SupabaseStub } from "@test/supabaseStub";
import { retrievability, getReviewQueue, recordReview } from "@/services/review";

const DAY = 86_400_000;
const NOW = Date.parse("2026-06-18T00:00:00Z");
const daysAgo = (n: number) => new Date(NOW - n * DAY).toISOString();

let stub: SupabaseStub;
beforeEach(() => {
  stub = createSupabaseStub();
  holder.client = stub.client;
});

/** A review_queue() row (resolved meaning/readings + server-computed R). */
const qrow = (over: Record<string, unknown> = {}) => ({
  user_word_id: "uw",
  user_id: "u",
  input: "猫",
  source_lang: "JA",
  target_lang: "EN",
  dictionary_word_id: "w1",
  custom_translation: null,
  translation: "cat",
  input_reading: null,
  translation_reading: null,
  stability: null,
  confidence_rating: 0,
  last_reviewed_date: null,
  originally_translated_date: "2026-06-17T00:00:00Z",
  retrievability: 0,
  ...over,
});

describe("retrievability", () => {
  it("is 0 for a cold word (no stability) — most urgent", () => {
    expect(retrievability(null, null, null, NOW)).toBe(0);
    expect(retrievability(null, daysAgo(1), null, NOW)).toBe(0);
    expect(retrievability(0, null, daysAgo(5), NOW)).toBe(0); // stability 0 = cold
  });

  it("is ~1 immediately after review and decays toward 0 over time", () => {
    expect(retrievability(5, daysAgo(0), null, NOW)).toBeCloseTo(1, 5);
    // at Δ = stability, R = e^-1 ≈ 0.368
    expect(retrievability(5, daysAgo(5), null, NOW)).toBeCloseTo(Math.exp(-1), 5);
    // a stronger word decays slower: same elapsed time → higher R
    expect(retrievability(20, daysAgo(5), null, NOW)).toBeGreaterThan(
      retrievability(5, daysAgo(5), null, NOW)
    );
  });

  it("a SEEDED but never-reviewed word decays from its translate date (#10 affects ranking)", () => {
    // stability set + never reviewed → NOT a cold 0; decays from originally-translated.
    expect(retrievability(5, null, daysAgo(5), NOW)).toBeCloseTo(Math.exp(-1), 5);
    expect(retrievability(5, null, daysAgo(0), NOW)).toBeCloseTo(1, 5); // fresh seed
    // last-reviewed takes precedence over the translate date when both present.
    expect(retrievability(5, daysAgo(0), daysAgo(100), NOW)).toBeCloseTo(1, 5);
  });
});

describe("getReviewQueue", () => {
  it("calls review_queue with the user/limit/list and maps the ranked rows", async () => {
    // SQL already ranked + limited; the service just maps rows to ReviewQueueItem.
    stub.rpc.mockResolvedValue({
      data: [
        qrow({ user_word_id: "new", retrievability: 0 }),
        qrow({ user_word_id: "weak", stability: 2, last_reviewed_date: daysAgo(10), retrievability: 0.0067 }),
      ],
      error: null,
    });

    const queue = await getReviewQueue({ userId: "u", listId: "L1", limit: 2 });

    expect(stub.rpc).toHaveBeenCalledWith("review_queue", {
      p_user_id: "u",
      p_limit: 2,
      p_list_id: "L1",
    });
    expect(queue.map((w) => w.userWordId)).toEqual(["new", "weak"]);
    expect(queue[0]).toMatchObject({ retrievability: 0, translation: "cat", confidenceRating: 0 });
    expect(queue[1]?.retrievability).toBeLessThan(0.05);
  });

  it("passes p_list_id undefined for the whole vocabulary (ALL)", async () => {
    stub.rpc.mockResolvedValue({ data: [], error: null });
    const queue = await getReviewQueue({ userId: "u", limit: 5 });
    expect(stub.rpc).toHaveBeenCalledWith("review_queue", {
      p_user_id: "u",
      p_limit: 5,
      p_list_id: undefined,
    });
    expect(queue).toEqual([]);
  });

  it("passes userWordIds to the RPC for SERVER-side restriction with the real limit", async () => {
    // The RPC now filters + ranks + limits; the service just maps what comes back.
    stub.rpc.mockResolvedValue({
      data: [
        qrow({ user_word_id: "a", retrievability: 0 }),
        qrow({ user_word_id: "c", retrievability: 0.2 }),
      ],
      error: null,
    });
    const queue = await getReviewQueue({ userId: "u", listId: "L1", limit: 2, userWordIds: ["c", "a"] });
    expect(stub.rpc).toHaveBeenCalledWith("review_queue", {
      p_user_id: "u", p_limit: 2, p_list_id: "L1", p_user_word_ids: ["c", "a"],
    });
    expect(queue.map((w) => w.userWordId)).toEqual(["a", "c"]);
  });

  it("passes [] through so the RPC filters to nothing (empty queue)", async () => {
    stub.rpc.mockResolvedValue({ data: [], error: null });
    const queue = await getReviewQueue({ userId: "u", limit: 5, userWordIds: [] });
    expect(stub.rpc).toHaveBeenCalledWith("review_queue", {
      p_user_id: "u", p_limit: 5, p_list_id: undefined, p_user_word_ids: [],
    });
    expect(queue).toEqual([]);
  });

  it("throws on an RPC error", async () => {
    stub.rpc.mockResolvedValue({ data: null, error: { message: "boom" } });
    await expect(getReviewQueue({ userId: "u", limit: 5 })).rejects.toBeTruthy();
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
