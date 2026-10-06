// @vitest-environment jsdom
// Replaying grades taken offline. The queue holds the only copy of work the user already
// did, so the contract is: drop an entry only after the server confirms it, keep a card's
// grades in the order they were given, and let one failing card not block the others.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { memStore } from "@test/offlineStore";
import { __setOfflineStore, type OfflineStore } from "@/services/offline/store";

vi.mock("@/services/review", () => ({
  sendReview: vi.fn(),
  isUnreachableError: (e: unknown) => e instanceof TypeError,
}));

import { drainPendingReviews, watchForReconnect } from "@/services/offline/sync";
import { enqueue, pending } from "@/services/offline/queue";
import { sendReview } from "@/services/review";

const mockSend = vi.mocked(sendReview);
const g = (id: string, userWordId: string, grade: 1 | 2 | 3 | 4 | 5 = 4) => ({
  id, userWordId, grade, reviewedAt: `2026-08-08T10:00:0${id.slice(-1)}.000Z`, approx: false,
});

let store: OfflineStore;
beforeEach(() => {
  store = memStore();
  __setOfflineStore(store);
  vi.clearAllMocks();
  mockSend.mockResolvedValue({ userWordId: "x", stability: 1, confidenceRating: 1, lastReviewedDate: "" });
});

describe("drainPendingReviews", () => {
  it("sends every queued grade and drops each one the server confirmed", async () => {
    await enqueue(store, g("e1", "a"));
    await enqueue(store, g("e2", "b"));

    expect(await drainPendingReviews()).toEqual({ sent: 2, failed: 0, remaining: 0, unreachable: false });
    expect(mockSend).toHaveBeenCalledWith({ userWordId: "a", grade: 4, reviewedAt: g("e1", "a").reviewedAt });
    expect(await pending(store)).toEqual([]);
  });

  it("replays a grade with the direction it was given in", async () => {
    await enqueue(store, { ...g("e1", "a"), reversed: true });
    await drainPendingReviews();
    expect(mockSend).toHaveBeenCalledWith({
      userWordId: "a", grade: 4, reviewedAt: g("e1", "a").reviewedAt, reversed: true,
    });
  });

  it("is a no-op with nothing queued", async () => {
    expect(await drainPendingReviews()).toEqual({ sent: 0, failed: 0, remaining: 0, unreachable: false });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("keeps a card's grades in order, and stops that card at its first failure", async () => {
    await enqueue(store, g("e1", "a", 1));
    await enqueue(store, g("e2", "a", 5));
    await enqueue(store, g("e3", "b", 3));
    mockSend.mockImplementation(async ({ userWordId, grade }) => {
      if (userWordId === "a" && grade === 1) throw new Error("offline again");
      return { userWordId, stability: 1, confidenceRating: 1, lastReviewedDate: "" };
    });

    const res = await drainPendingReviews();

    // Card a: e1 failed, so e2 was NOT sent ahead of it. Card b still drained.
    expect(mockSend.mock.calls.map(([p]) => `${p.userWordId}${p.grade}`).sort()).toEqual(["a1", "b3"]);
    expect(res).toMatchObject({ sent: 1, failed: 1 });
    expect((await pending(store)).map((e) => e.id)).toEqual(["e1", "e2"]); // nothing lost
  });

  it("an UNREACHABLE server is not a failed attempt — nothing is counted toward shelving", async () => {
    // "online" fires on a captive portal too. Five of those must not strand a good grade.
    await enqueue(store, g("e1", "a"));
    await enqueue(store, g("e2", "b"));
    mockSend.mockRejectedValue(new TypeError("Load failed"));

    for (let i = 0; i < 6; i++) {
      expect(await drainPendingReviews()).toEqual({ sent: 0, failed: 0, remaining: 2, unreachable: true });
    }
    expect((await pending(store)).map((e) => e.attempts)).toEqual([0, 0]);

    mockSend.mockResolvedValue({ userWordId: "x", stability: 1, confidenceRating: 1, lastReviewedDate: "" });
    expect(await drainPendingReviews()).toEqual({ sent: 2, failed: 0, remaining: 0, unreachable: false });
  });

  it("stops trying the remaining cards once the server is unreachable", async () => {
    for (const id of ["a", "b", "c", "d", "e", "f", "g", "h"]) await enqueue(store, g(`e-${id}`, id));
    mockSend.mockRejectedValue(new TypeError("Load failed"));

    await drainPendingReviews();
    expect(mockSend.mock.calls.length).toBeLessThanOrEqual(4); // the first concurrent wave only
  });

  it("a REFUSAL still counts, so a poison entry is eventually shelved", async () => {
    await enqueue(store, g("e1", "a"));
    mockSend.mockRejectedValue(new Error("invalid grade"));

    expect(await drainPendingReviews()).toEqual({ sent: 0, failed: 1, remaining: 1, unreachable: false });
    expect((await pending(store))[0].attempts).toBe(1);
  });

  it("shares one drain between concurrent callers", async () => {
    await enqueue(store, g("e1", "a"));
    const [x, y] = [drainPendingReviews(), drainPendingReviews()];
    expect(x).toBe(y);
    await x;
    expect(mockSend).toHaveBeenCalledTimes(1);
  });
});

describe("watchForReconnect", () => {
  it("drains once at start and again on each 'online' event, until torn down", async () => {
    await enqueue(store, g("e1", "a"));

    const stop = watchForReconnect();
    await vi.waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1));

    await enqueue(store, g("e2", "b"));
    window.dispatchEvent(new Event("online"));
    await vi.waitFor(() => expect(mockSend).toHaveBeenCalledTimes(2));

    stop();
    await enqueue(store, g("e3", "c"));
    window.dispatchEvent(new Event("online"));
    await new Promise((r) => setTimeout(r, 10));
    expect(mockSend).toHaveBeenCalledTimes(2);
  });
});
