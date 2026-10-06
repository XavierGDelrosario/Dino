// Goals: the projection arithmetic, the defaults, and that an un-migrated database
// (no goal columns yet, 42703) reads as the defaults instead of an error.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSupabaseStub } from "@test/supabaseStub";

// vi.mock is hoisted above the stub's creation, so the client is resolved lazily.
const stub = createSupabaseStub();
vi.mock("@/config/supabaseClient", () => ({
  get supabase() {
    return stub.client;
  },
}));

import {
  DEFAULT_GOALS,
  NEW_WORDS_GOAL_OPTIONS,
  REVIEWS_GOAL_OPTIONS,
  getGoals,
  projections,
  resetGoalsAvailability,
  setGoals,
} from "@/services/goals";

beforeEach(() => {
  stub.calls.length = 0;
  resetGoalsAvailability();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("projections", () => {
  it("multiplies the goal by each horizon's days", () => {
    expect(projections(5).map((p) => [p.key, p.total])).toEqual([
      ["week", 35],
      ["month", 150],
      ["halfYear", 910],
      ["year", 1825],
    ]);
  });
});

describe("defaults", () => {
  it("are the smallest button of each row", () => {
    expect(DEFAULT_GOALS).toEqual({ newWords: NEW_WORDS_GOAL_OPTIONS[0], reviews: REVIEWS_GOAL_OPTIONS[0] });
  });
});

describe("getGoals", () => {
  it("fills NULL columns with the defaults", async () => {
    stub.queueFrom("users", { data: { daily_new_words_goal: 20, daily_reviews_goal: null }, error: null });
    expect(await getGoals("u1")).toEqual({ newWords: 20, reviews: DEFAULT_GOALS.reviews });
  });

  it("reads as the defaults on a database without the columns, and stops asking", async () => {
    stub.queueFrom("users", { data: null, error: { code: "42703", message: "column does not exist" } });
    expect(await getGoals("u1")).toEqual(DEFAULT_GOALS);
    const reads = stub.fromCalls.length;
    expect(await getGoals("u1")).toEqual(DEFAULT_GOALS);
    expect(stub.fromCalls.length).toBe(reads); // latched — no second round-trip
    await setGoals("u1", { newWords: 40 }); // and a write is swallowed, not thrown
    expect(stub.fromCalls.length).toBe(reads);
  });
});

describe("setGoals", () => {
  it("writes only the fields given", async () => {
    stub.queueFrom("users", { data: null, error: null });
    await setGoals("u1", { reviews: 100 });
    const [update] = stub.callsFor("users", "update");
    expect(update.args[0]).toEqual({ daily_reviews_goal: 100 });
    expect(stub.callsFor("users", "eq")[0].args).toEqual(["user_id", "u1"]);
  });
});
