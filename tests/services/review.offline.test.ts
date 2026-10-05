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

import {
  getReviewQueue,
  recordReview,
  refreshOfflineDeck,
  sendReview,
  watchOfflineDeck,
  OFFLINE_DECK_SIZE,
  __resetDirectionProbe,
  type ReviewQueueItem,
} from "@/services/review";
import { __setOfflineStore, __resetOfflineStore, type OfflineStore } from "@/services/offline/store";
import { pending } from "@/services/offline/queue";
import { setAnchor, type ClockAnchor } from "@/services/offline/clock";
import { saveDeck } from "@/services/offline/deck";
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

// What supabase-js ACTUALLY hands back when fetch fails: it does not throw, it resolves
// an error with an empty `code`, the engine's own wording, and `status: 0`.
const noResponse = (wording: string) => ({
  data: null,
  error: { message: `TypeError: ${wording}`, details: "", hint: "", code: "" },
  status: 0,
});

describe("recordReview — unreachable, as the client reports it", () => {
  it.each([
    ["Chrome", "Failed to fetch"],
    ["WebKit (Safari / the iOS app)", "Load failed"],
    ["an engine whose wording we have never seen", "Something else entirely"],
  ])("QUEUES the grade on %s", async (_engine, wording) => {
    stub.rpc.mockResolvedValue(noResponse(wording));

    const res = await recordReview(CARD);
    expect(res.queued).toBe(true);
    expect(await pending(store)).toHaveLength(1);
  });

  it("a refusal with an empty code but a real HTTP status is still a verdict", async () => {
    // PostgREST answers a non-JSON error body with `code: ""` too — only the status
    // tells it apart from a request that never landed.
    stub.rpc.mockResolvedValue({
      data: null,
      error: { message: "Bad Gateway", details: "", hint: "", code: "" },
      status: 502,
    });
    await expect(recordReview(CARD)).rejects.toThrow();
    expect(await pending(store)).toEqual([]);
  });
});

describe("getReviewQueue — unreachable, as the client reports it", () => {
  it("deals the cached deck on WebKit's wording", async () => {
    const anchor: ClockAnchor = { serverNow: Date.now(), mono: 0 };
    await saveDeck(store, { userId: "u", listId: null, anchor, items: [{ userWordId: "uw1" } as ReviewQueueItem] });

    stub.rpc.mockResolvedValue(noResponse("Load failed"));
    const deck = await getReviewQueue({ userId: "u", limit: 5 });
    expect(deck.map((c) => c.userWordId)).toEqual(["uw1"]);
  });
});

describe("the full offline deck", () => {
  const row = (id: string) => ({
    user_word_id: id, user_id: "u", input: id, source_lang: "JA", target_lang: "EN",
    dictionary_word_id: null, custom_translation: "x", translation: "x",
    input_reading: null, translation_reading: null, proficiency_band: null,
    part_of_speech: null, frequency: null, stability: 3, confidence_rating: 2,
    last_reviewed_date: null, originally_translated_date: "2026-08-01T00:00:00Z",
    retrievability: 0.5,
  });
  const IDS = ["a", "b", "c", "d", "e"];
  /** The server, online: the queue honours p_limit / p_list_id like review_queue does. */
  const online = () =>
    stub.rpc.mockImplementation(async (fn: string, args: { p_limit: number; p_list_id?: string }) => {
      if (fn === "server_now") return { data: new Date().toISOString(), error: null, status: 200 };
      const ids = args.p_list_id ? ["L1", "L2"] : IDS;
      return { data: ids.slice(0, args.p_limit).map(row), error: null, status: 200 };
    });
  const offline = () => stub.rpc.mockResolvedValue(noResponse("Load failed"));
  const ids = (deck: ReviewQueueItem[]) => deck.map((c) => c.userWordId);

  it("asks the server for a deep cut of the whole vocabulary", async () => {
    online();
    expect(await refreshOfflineDeck("u")).toBe(true);
    const [fn, args] = stub.rpc.mock.calls[0];
    expect(fn).toBe("review_queue");
    expect(args).toMatchObject({ p_user_id: "u", p_limit: OFFLINE_DECK_SIZE });
    expect(args.p_list_id).toBeUndefined();
  });

  it("an online session does not shrink it to that one session", async () => {
    online();
    await refreshOfflineDeck("u");
    await getReviewQueue({ userId: "u", limit: 2 }); // caches a 2-card session deck

    offline();
    expect(ids(await getReviewQueue({ userId: "u", limit: 4 }))).toEqual(["a", "b", "c", "d"]);
  });

  it("a second offline session deals the NEXT cards, not the ones just graded", async () => {
    online();
    await refreshOfflineDeck("u");
    offline();

    const first = await getReviewQueue({ userId: "u", limit: 2 });
    for (const card of first) await recordReview({ userWordId: card.userWordId, grade: 4 });

    expect(ids(await getReviewQueue({ userId: "u", limit: 2 }))).toEqual(["c", "d"]);
  });

  it("is EMPTY, not an error, once every cached card has been graded", async () => {
    online();
    await refreshOfflineDeck("u");
    offline();
    for (const id of IDS) await recordReview({ userWordId: id, grade: 4 });

    expect(await getReviewQueue({ userId: "u", limit: 2 })).toEqual([]);
  });

  it("never deals the whole-vocabulary deck into a LIST", async () => {
    online();
    await refreshOfflineDeck("u");
    offline();
    await expect(getReviewQueue({ userId: "u", listId: "list-1", limit: 2 })).rejects.toThrow();
  });

  it("a list still gets the last session dealt in it", async () => {
    online();
    await refreshOfflineDeck("u");
    await getReviewQueue({ userId: "u", listId: "list-1", limit: 2 });
    offline();
    expect(ids(await getReviewQueue({ userId: "u", listId: "list-1", limit: 2 }))).toEqual(["L1", "L2"]);
  });

  it("a failed refresh leaves the deck on the device alone", async () => {
    online();
    await refreshOfflineDeck("u");
    offline();
    expect(await refreshOfflineDeck("u")).toBe(false);
    expect(ids(await getReviewQueue({ userId: "u", limit: 2 }))).toEqual(["a", "b"]);
  });

  it("re-fetches shortly after grades reach the server, once per burst", async () => {
    vi.useFakeTimers();
    try {
      online();
      const stop = watchOfflineDeck("u");
      await vi.advanceTimersByTimeAsync(0);
      const queueCalls = () => stub.rpc.mock.calls.filter(([fn]) => fn === "review_queue").length;
      expect(queueCalls()).toBe(1); // the fetch at start

      stub.rpc.mockImplementation(async (fn: string) =>
        fn === "record_review"
          ? { data: { user_word_id: "a", stability: 1, confidence_rating: 1, last_reviewed_date: "x" }, error: null, status: 200 }
          : fn === "server_now"
            ? { data: new Date().toISOString(), error: null, status: 200 }
            : { data: [], error: null, status: 200 });
      await sendReview({ userWordId: "a", grade: 4 });
      await sendReview({ userWordId: "b", grade: 4 });
      expect(queueCalls()).toBe(1);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(queueCalls()).toBe(2);
      stop();
    } finally {
      vi.useRealTimers();
    }
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
