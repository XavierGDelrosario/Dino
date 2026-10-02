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

import { recordReview, sendReview, __resetDirectionProbe } from "@/services/review";
import { __setOfflineStore, __resetOfflineStore, type OfflineStore } from "@/services/offline/store";
import { pending } from "@/services/offline/queue";
import { setAnchor } from "@/services/offline/clock";
import { memStore } from "@test/offlineStore";


let stub: SupabaseStub;
let store: OfflineStore;
beforeEach(() => {
  stub = createSupabaseStub();
  holder.client = stub.client;
  store = memStore();
  __setOfflineStore(store);
  setAnchor(null);
  __resetDirectionProbe(); // module-global latch — reset between cases
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

  const ROW = { user_word_id: "uw1", stability: 1, confidence_rating: 1, last_reviewed_date: "x" };

  it("sends the card's direction when it has one, and nothing when it doesn't", async () => {
    stub.rpc.mockResolvedValue({ data: ROW, error: null });

    await sendReview({ userWordId: "uw1", grade: 3, reversed: true });
    expect(stub.rpc.mock.calls[0][1]).toMatchObject({ p_reversed: true });
    await sendReview({ userWordId: "uw1", grade: 3, reversed: false });
    expect(stub.rpc.mock.calls[1][1]).toMatchObject({ p_reversed: false });
    // An old queued grade has no direction: it must stay "not recorded", not become false.
    await sendReview({ userWordId: "uw1", grade: 3 });
    expect(stub.rpc.mock.calls[2][1].p_reversed).toBeUndefined();
  });

  // The client and the database deploy separately. A build that knows about direction
  // against a database that doesn't must still record the GRADE.
  it("a database without p_reversed still gets the grade — once, then stops asking", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    stub.rpc
      .mockResolvedValueOnce({ data: null, error: { code: "PGRST202", message: "no function" } })
      .mockResolvedValue({ data: ROW, error: null });

    const res = await sendReview({ userWordId: "uw1", grade: 3, reversed: true });
    expect(res.userWordId).toBe("uw1");
    expect(stub.rpc).toHaveBeenCalledTimes(2);
    expect(stub.rpc.mock.calls[1][1].p_reversed).toBeUndefined();

    // Latched: the next review goes straight to the form the database has.
    await sendReview({ userWordId: "uw1", grade: 4, reversed: true });
    expect(stub.rpc).toHaveBeenCalledTimes(3);
    expect(stub.rpc.mock.calls[2][1].p_reversed).toBeUndefined();
    warn.mockRestore();
  });

  it("a queued grade keeps its direction for the replay", async () => {
    stub.rpc.mockRejectedValue(new TypeError("Failed to fetch"));
    await recordReview({ ...CARD, reversed: true });
    expect((await pending(store))[0]).toMatchObject({ userWordId: "uw1", grade: 4, reversed: true });
  });

  it("NEVER queues — the drain uses it, and re-queueing would loop", async () => {
    stub.rpc.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(sendReview({ userWordId: "uw1", grade: 3 })).rejects.toThrow();
    expect(await pending(store)).toEqual([]);
  });
});

afterEach(() => __resetOfflineStore());
