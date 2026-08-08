// The line that matters in the offline path: a server that is UNREACHABLE falls back;
// a server that ANSWERED WITH A REFUSAL must not. Getting that backwards would either
// queue a permanent failure forever (retrying an invalid grade on every reconnect) or
// throw away a review the user actually did.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSupabaseStub, type SupabaseStub } from "@test/supabaseStub";

const { holder } = vi.hoisted(() => ({ holder: { client: null as unknown as SupabaseStub["client"] } }));
vi.mock("@/config/supabaseClient", () => ({
  supabase: new Proxy({}, { get: (_t, p) => holder.client[p as keyof typeof holder.client] }),
}));

import { recordReview, sendReview } from "@/services/review";
import { __setOfflineStore, __resetOfflineStore, type OfflineStore } from "@/services/offline/store";
import { pending } from "@/services/offline/queue";
import { setAnchor } from "@/services/offline/clock";

function memStore(): OfflineStore {
  const m = new Map<string, unknown>();
  return {
    get: async <T,>(k: string) => (m.has(k) ? (m.get(k) as T) : null),
    set: async <T,>(k: string, v: T) => void m.set(k, v),
    del: async (k: string) => void m.delete(k),
  };
}

let stub: SupabaseStub;
let store: OfflineStore;
beforeEach(() => {
  stub = createSupabaseStub();
  holder.client = stub.client;
  store = memStore();
  __setOfflineStore(store);
  setAnchor(null);
});

const CARD = { userWordId: "uw1", grade: 4 as const };

describe("recordReview — online", () => {
  it("records normally and queues nothing", async () => {
    stub.rpc.mockResolvedValue({
      data: { user_word_id: "uw1", stability: 12, confidence_rating: 4, last_reviewed_date: "2026-08-08T10:00:00Z" },
      error: null,
    });

    const res = await recordReview(CARD);
    expect(res.queued).toBeUndefined();
    expect(res.stability).toBe(12);
    expect(await pending(store)).toEqual([]);
  });
});

describe("recordReview — unreachable", () => {
  it("QUEUES the grade and reports it as queued", async () => {
    stub.rpc.mockRejectedValue(new TypeError("Failed to fetch"));

    const res = await recordReview({
      ...CARD,
      current: { stability: 7, confidenceRating: 3, lastReviewedDate: "2026-08-01T00:00:00Z" },
    });

    expect(res.queued).toBe(true);
    const q = await pending(store);
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({ userWordId: "uw1", grade: 4, attempts: 0 });
    expect(q[0].reviewedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("echoes the card's PRE-review values rather than inventing a schedule", async () => {
    // The real stability needs srs_leveling(), which is revoked from clients (20260748),
    // so any number guessed here would differ from the server's and be silently
    // corrected on sync. Better to show the old one and mark it queued.
    stub.rpc.mockRejectedValue(new TypeError("Failed to fetch"));

    const res = await recordReview({
      ...CARD,
      current: { stability: 7, confidenceRating: 3, lastReviewedDate: "2026-08-01T00:00:00Z" },
    });
    expect(res.stability).toBe(7);
    expect(res.confidenceRating).toBe(3);
  });

  it("marks the stamp APPROX when there is no anchor (cold start offline)", async () => {
    stub.rpc.mockRejectedValue(new TypeError("Failed to fetch"));
    await recordReview(CARD);
    expect((await pending(store))[0].approx).toBe(true);
  });
});

describe("recordReview — the server REFUSED", () => {
  it("throws on a PostgREST error instead of queueing", async () => {
    // A SQLSTATE means the database answered. Queueing this would retry a permanent
    // failure on every single reconnect.
    stub.rpc.mockResolvedValue({
      data: null,
      error: { code: "P0001", message: "invalid grade 9 (expected 1-5)" },
    });

    await expect(recordReview({ userWordId: "uw1", grade: 9 as never })).rejects.toThrow();
    expect(await pending(store)).toEqual([]);
  });

  it("throws on an HTTP status (e.g. an RLS denial) instead of queueing", async () => {
    stub.rpc.mockResolvedValue({ data: null, error: { status: 403, message: "forbidden" } });
    await expect(recordReview(CARD)).rejects.toThrow();
    expect(await pending(store)).toEqual([]);
  });
});

describe("sendReview", () => {
  it("passes p_reviewed_at through for a replay", async () => {
    stub.rpc.mockResolvedValue({
      data: { user_word_id: "uw1", stability: 1, confidence_rating: 1, last_reviewed_date: "x" },
      error: null,
    });

    await sendReview({ userWordId: "uw1", grade: 3, reviewedAt: "2026-08-08T09:00:00.000Z" });
    expect(stub.rpc).toHaveBeenCalledWith("record_review", {
      p_user_word_id: "uw1",
      p_grade: 3,
      p_reviewed_at: "2026-08-08T09:00:00.000Z",
    });
  });

  it("NEVER queues — the drain uses it, and re-queueing would loop", async () => {
    stub.rpc.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(sendReview({ userWordId: "uw1", grade: 3 })).rejects.toThrow();
    expect(await pending(store)).toEqual([]);
  });
});

afterEach(() => __resetOfflineStore());
