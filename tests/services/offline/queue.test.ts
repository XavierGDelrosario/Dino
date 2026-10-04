// The queue holds the ONLY copy of work the user has already done, so these tests are
// about not losing it: a failed replay keeps the entry, only a confirmed one drops it,
// and a permanently-failing entry stops blocking the rest without disappearing.
import { describe, it, expect, beforeEach } from "vitest";
import {
  acknowledge,
  clearQueue,
  drainable,
  enqueue,
  markFailed,
  pending,
  pendingCount,
  MAX_ATTEMPTS,
  type PendingGrade,
} from "@/services/offline/queue";
import type { OfflineStore } from "@/services/offline/store";
import { memStore } from "@test/offlineStore";


let store: OfflineStore;
beforeEach(() => { store = memStore(); });

const grade = (id: string, userWordId = "w1") => ({
  id, userWordId, grade: 4 as const, reviewedAt: "2026-08-08T10:00:00.000Z", approx: false,
});

describe("enqueue / pending", () => {
  it("starts empty", async () => {
    expect(await pending(store)).toEqual([]);
    expect(await pendingCount(store)).toBe(0);
  });

  it("appends in order — replay order matters for two grades of the same card", async () => {
    await enqueue(store, grade("a"));
    await enqueue(store, grade("b"));
    expect((await pending(store)).map((e) => e.id)).toEqual(["a", "b"]);
  });

  it("records zero attempts on a new entry", async () => {
    await enqueue(store, grade("a"));
    expect((await pending(store))[0].attempts).toBe(0);
  });
});

describe("acknowledge", () => {
  it("drops ONLY what the server confirmed", async () => {
    await enqueue(store, grade("a"));
    await enqueue(store, grade("b"));
    await acknowledge(store, ["a"]);
    expect((await pending(store)).map((e) => e.id)).toEqual(["b"]);
  });

  it("is a no-op for an empty list", async () => {
    await enqueue(store, grade("a"));
    await acknowledge(store, []);
    expect(await pendingCount(store)).toBe(1);
  });
});

describe("markFailed", () => {
  it("KEEPS the entry and counts the attempt", async () => {
    await enqueue(store, grade("a"));
    await markFailed(store, ["a"]);
    const [e] = await pending(store);
    expect(e.id).toBe("a");      // still queued — losing it would lose the review
    expect(e.attempts).toBe(1);
  });
});

describe("drainable — per user", () => {
  const entry = (id: string, userId?: string) =>
    ({ id, userWordId: "w", grade: 3, reviewedAt: "2026-01-01T00:00:00Z", approx: false, attempts: 0, userId }) as const;

  it("holds another user's grades back and keeps unstamped legacy entries", () => {
    const q = [entry("mine", "u1"), entry("theirs", "u2"), entry("legacy")];
    expect(drainable(q, "u1").map((e) => e.id)).toEqual(["mine", "legacy"]);
  });

  it("with no session to compare against, drains as before", () => {
    const q = [entry("a", "u1"), entry("b", "u2")];
    expect(drainable(q, null).map((e) => e.id)).toEqual(["a", "b"]);
  });
});

describe("drainable", () => {
  it("returns everything under the attempt ceiling", () => {
    const q = [
      { ...grade("a"), attempts: 0 },
      { ...grade("b"), attempts: MAX_ATTEMPTS - 1 },
    ] as PendingGrade[];
    expect(drainable(q).map((e) => e.id)).toEqual(["a", "b"]);
  });

  it("skips a poison entry so it cannot wedge the queue behind it", () => {
    const q = [
      { ...grade("poison"), attempts: MAX_ATTEMPTS },
      { ...grade("good"), attempts: 0 },
    ] as PendingGrade[];
    expect(drainable(q).map((e) => e.id)).toEqual(["good"]);
  });

  it("shelves it WITHOUT deleting it — it stays inspectable", async () => {
    await enqueue(store, grade("poison"));
    for (let i = 0; i < MAX_ATTEMPTS; i++) await markFailed(store, ["poison"]);
    expect(drainable(await pending(store))).toEqual([]);
    expect(await pendingCount(store)).toBe(1);
  });
});

describe("clearQueue", () => {
  it("empties it — for sign-out, since a queue belongs to one user", async () => {
    await enqueue(store, grade("a"));
    await clearQueue(store);
    expect(await pending(store)).toEqual([]);
  });
});
