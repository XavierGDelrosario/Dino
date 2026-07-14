import { describe, it, expect, vi, beforeEach } from "vitest";

// admin.ts reads everything through supabase.rpc (the admin_* SECURITY DEFINER
// functions); these unit tests assert the snake_case→camelCase mapping + arg
// passing + that an RPC error propagates as a thrown ServiceError. The RPC behavior
// (gating, append-only) is covered separately by admin.integration.test.ts.
const { holder } = vi.hoisted(() => ({ holder: { client: null as unknown as SupabaseStub["client"] } }));
vi.mock("@/config/supabaseClient", () => ({
  supabase: new Proxy({}, { get: (_t, p) => holder.client[p as keyof typeof holder.client] }),
}));

import { createSupabaseStub, type SupabaseStub } from "@test/supabaseStub";
import {
  getIsAdmin, getUsageOverview, getTableSizes, getErrorLog,
  grantFeature, listGrants, getProviderHealth, setProvider,
  reportQualityIssue, listQualityReports,
} from "@/services/admin";

let stub: SupabaseStub;
beforeEach(() => {
  stub = createSupabaseStub();
  holder.client = stub.client;
});

describe("getIsAdmin", () => {
  it("returns true only when the RPC returns true", async () => {
    stub.rpc.mockResolvedValue({ data: true, error: null });
    expect(await getIsAdmin()).toBe(true);
    stub.rpc.mockResolvedValue({ data: false, error: null });
    expect(await getIsAdmin()).toBe(false);
    stub.rpc.mockResolvedValue({ data: null, error: null });
    expect(await getIsAdmin()).toBe(false);
  });
  it("throws on an RPC error", async () => {
    stub.rpc.mockResolvedValue({ data: null, error: { message: "denied", code: "42501" } });
    await expect(getIsAdmin()).rejects.toBeTruthy();
  });
});

describe("getUsageOverview", () => {
  it("splits the global row from per-user rows and camelCases", async () => {
    stub.rpc.mockResolvedValue({
      data: [
        { scope: "global", bucket: null, period_month: "2026-06-01", chars_used: 5678 },
        { scope: "user", bucket: "abc123", period_month: "2026-06-01", chars_used: 1234 },
      ],
      error: null,
    });
    const out = await getUsageOverview("2026-06-01");
    expect(stub.rpc).toHaveBeenCalledWith("admin_usage_overview", { p_month: "2026-06-01" });
    expect(out.global).toMatchObject({ scope: "global", charsUsed: 5678, bucket: null });
    expect(out.users).toEqual([{ scope: "user", bucket: "abc123", periodMonth: "2026-06-01", charsUsed: 1234 }]);
  });
  it("omits p_month when no month is given", async () => {
    stub.rpc.mockResolvedValue({ data: [], error: null });
    await getUsageOverview();
    expect(stub.rpc).toHaveBeenCalledWith("admin_usage_overview", {});
  });
});

describe("getTableSizes / getErrorLog / getProviderHealth mapping", () => {
  it("maps table sizes", async () => {
    stub.rpc.mockResolvedValue({ data: [{ table_name: "words", total_bytes: 100, table_bytes: 80, row_estimate: 9 }], error: null });
    expect(await getTableSizes()).toEqual([{ tableName: "words", totalBytes: 100, tableBytes: 80, rowEstimate: 9 }]);
  });
  it("maps + filters the error log", async () => {
    stub.rpc.mockResolvedValue({ data: [{ id: 1, occurred_at: "t", error_code: "x", source: "s", user_id: "u", input: "i", detail: "d" }], error: null });
    const rows = await getErrorLog({ since: "2026-06-01", code: "x", userId: "u", limit: 50 });
    expect(stub.rpc).toHaveBeenCalledWith("admin_error_log", { p_since: "2026-06-01", p_code: "x", p_user: "u", p_limit: 50 });
    expect(rows[0]).toEqual({ id: 1, occurredAt: "t", errorCode: "x", source: "s", userId: "u", input: "i", detail: "d" });
  });
  it("maps provider health", async () => {
    stub.rpc.mockResolvedValue({ data: [{ provider: "brevo", credential_expires_at: "2026-08-01", days_to_expiry: 30, quota_note: "n", mt_chars_used: null, updated_at: "t" }], error: null });
    expect((await getProviderHealth())[0]).toEqual({ provider: "brevo", expiresAt: "2026-08-01", daysToExpiry: 30, quotaNote: "n", mtCharsUsed: null, updatedAt: "t" });
  });
});

describe("write RPCs pass args + propagate errors", () => {
  it("grantFeature passes trimmed args", async () => {
    stub.rpc.mockResolvedValue({ data: {}, error: null });
    await grantFeature({ email: " a@b.c ", feature: " voice ", value: 5, expiresAt: "2026-09-01", note: "n" });
    expect(stub.rpc).toHaveBeenCalledWith("admin_grant_feature", { p_email: "a@b.c", p_feature: "voice", p_value: 5, p_expires_at: "2026-09-01", p_note: "n" });
  });
  it("setProvider passes args", async () => {
    stub.rpc.mockResolvedValue({ data: {}, error: null });
    await setProvider({ provider: "brevo", expiresAt: "2026-09-01", quotaNote: "n" });
    expect(stub.rpc).toHaveBeenCalledWith("admin_set_provider", { p_provider: "brevo", p_expires_at: "2026-09-01", p_quota_note: "n" });
  });
  it("reportQualityIssue passes trimmed args", async () => {
    stub.rpc.mockResolvedValue({ data: {}, error: null });
    await reportQualityIssue({ input: " 辛い ", description: " wrong sense " });
    expect(stub.rpc).toHaveBeenCalledWith("admin_report_quality_issue", { p_input: "辛い", p_description: "wrong sense" });
  });
  it("listQualityReports maps rows, omits p_limit by default, propagates an error", async () => {
    stub.rpc.mockResolvedValue({ data: [{ id: 3, reported_at: "t", reported_by: "u1", input: "辛い", description: "wrong sense" }], error: null });
    expect((await listQualityReports())[0]).toEqual({ id: 3, reportedAt: "t", reportedBy: "u1", input: "辛い", description: "wrong sense" });
    expect(stub.rpc).toHaveBeenCalledWith("admin_quality_reports", {});
    await listQualityReports(50);
    expect(stub.rpc).toHaveBeenLastCalledWith("admin_quality_reports", { p_limit: 50 });
    stub.rpc.mockResolvedValue({ data: null, error: { message: "boom" } });
    await expect(listQualityReports()).rejects.toBeTruthy();
  });
  it("listGrants maps rows + propagates an error", async () => {
    stub.rpc.mockResolvedValue({ data: [{ id: 2, email: "a@b.c", feature: "voice", value: null, granted_at: "g", expires_at: null, active: true, note: null }], error: null });
    expect((await listGrants())[0]).toMatchObject({ id: 2, email: "a@b.c", feature: "voice", active: true });
    stub.rpc.mockResolvedValue({ data: null, error: { message: "boom" } });
    await expect(listGrants()).rejects.toBeTruthy();
  });
});
