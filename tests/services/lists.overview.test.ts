// getListOverview's DEPLOY-GAP behaviour. The client and the database ship
// separately, so there is always a window where a build calling list_overview() is live
// against a database that has not taken migration 20260773 — and the overview is the
// Lists tab's LANDING screen, so a throw there is not a degraded feature, it is the
// whole tab replaced by an error for every user. This pins the contract that makes the
// deploy ORDER forgiving instead of load-bearing.
import { describe, it, expect, vi, beforeEach } from "vitest";

const rpc = vi.fn();
vi.mock("@/config/supabaseClient", () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) } }));

import { getListOverview, __resetListOverviewProbe } from "@/services/lists";

const MISSING = { code: "PGRST202", message: "Could not find the function public.list_overview" };

const okRow = {
  list_id: null,
  list_name: null,
  created_at: null,
  last_word_added_at: null,
  word_count: 3,
  confidence: [1, 0, 0, 0, 0, 2],
};

beforeEach(() => {
  rpc.mockReset();
  __resetListOverviewProbe();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("getListOverview — the un-migrated database", () => {
  it("returns null instead of throwing when the function is absent", async () => {
    rpc.mockResolvedValue({ data: null, error: MISSING });
    await expect(getListOverview()).resolves.toBeNull();
  });

  it("latches, so an un-migrated database costs ONE failed RPC per session", async () => {
    rpc.mockResolvedValue({ data: null, error: MISSING });
    await getListOverview();
    await getListOverview();
    await getListOverview();
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("re-probes after a reset, so applying the migration heals without a redeploy", async () => {
    rpc.mockResolvedValue({ data: null, error: MISSING });
    expect(await getListOverview()).toBeNull();
    __resetListOverviewProbe();
    rpc.mockResolvedValue({ data: [okRow], error: null });
    expect(await getListOverview()).toHaveLength(1);
  });

  it("still THROWS on a real error — only a missing function is survivable", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "permission denied" } });
    await expect(getListOverview()).rejects.toBeTruthy();
    // and it must not latch off a failure that says nothing about the schema
    rpc.mockResolvedValue({ data: [okRow], error: null });
    expect(await getListOverview()).toHaveLength(1);
  });
});

describe("getListOverview — mapping", () => {
  it("pads a short confidence array rather than trusting its length", async () => {
    rpc.mockResolvedValue({ data: [{ ...okRow, confidence: [4, 1] }], error: null });
    const [row] = (await getListOverview())!;
    expect(row.confidence).toEqual([4, 1, 0, 0, 0, 0]);
  });

  it("survives a null confidence and a null count", async () => {
    rpc.mockResolvedValue({ data: [{ ...okRow, confidence: null, word_count: null }], error: null });
    const [row] = (await getListOverview())!;
    expect(row.confidence).toEqual([0, 0, 0, 0, 0, 0]);
    expect(row.wordCount).toBe(0);
  });

  it("keeps ALL identifiable by a null listId", async () => {
    rpc.mockResolvedValue({
      data: [okRow, { ...okRow, list_id: "l1", list_name: "Verbs", word_count: 9 }],
      error: null,
    });
    const rows = (await getListOverview())!;
    expect(rows[0].listId).toBeNull();
    expect(rows[1].listId).toBe("l1");
    expect(rows[1].listName).toBe("Verbs");
  });
});
