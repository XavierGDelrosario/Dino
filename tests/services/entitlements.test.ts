import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSupabaseStub, type SupabaseStub } from "@test/supabaseStub";

const { holder } = vi.hoisted(() => ({ holder: { client: null as any } }));
vi.mock("@/config/supabaseClient", () => ({
  supabase: new Proxy({}, { get: (_t, p) => holder.client[p as keyof typeof holder.client] }),
}));

import { getUserLimits, getMonthlyUsage, DEFAULT_LIMITS } from "@/services/entitlements";

let stub: SupabaseStub;
beforeEach(() => {
  stub = createSupabaseStub();
  holder.client = stub.client;
});

describe("getUserLimits", () => {
  it("returns the defaults when the user has no override row (the guest case)", async () => {
    stub.queueFrom("user_limits", { data: null, error: null });
    expect(await getUserLimits("guest")).toEqual(DEFAULT_LIMITS);
  });

  it("applies per-user overrides for both limits", async () => {
    stub.queueFrom("user_limits", {
      data: { paragraph_char_limit: 500, monthly_char_quota: 100_000 },
      error: null,
    });
    expect(await getUserLimits("u")).toEqual({
      paragraphCharLimit: 500,
      monthlyCharQuota: 100_000,
    });
  });

  it("falls back to the default for each NULL column independently", async () => {
    // Override only the monthly quota; paragraph cap stays at the default.
    stub.queueFrom("user_limits", {
      data: { paragraph_char_limit: null, monthly_char_quota: 50_000 },
      error: null,
    });
    expect(await getUserLimits("u")).toEqual({
      paragraphCharLimit: DEFAULT_LIMITS.paragraphCharLimit,
      monthlyCharQuota: 50_000,
    });
  });

  it("surfaces a query error as a ServiceError", async () => {
    stub.queueFrom("user_limits", { data: null, error: { message: "db down", code: "08006" } });
    await expect(getUserLimits("u")).rejects.toThrow("db down");
  });
});

describe("getMonthlyUsage", () => {
  it("returns the month-to-date character count", async () => {
    stub.queueFrom("translation_usage", { data: { chars_used: 1234 }, error: null });
    expect(await getMonthlyUsage("u")).toBe(1234);
  });

  it("returns 0 when there is no usage row this month", async () => {
    stub.queueFrom("translation_usage", { data: null, error: null });
    expect(await getMonthlyUsage("u")).toBe(0);
  });
});
