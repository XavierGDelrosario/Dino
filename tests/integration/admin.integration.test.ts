// Admin authorization layer — the privilege boundary from migrations 20260704–08
// (docs/TODO.md §8). The whole admin surface is protected ONLY by SQL (the is_admin
// column lock + is_admin()-gated SECURITY DEFINER RPCs), so these tests assert the
// gate actually holds against a real client. Gated behind RUN_INTEGRATION; the
// admin-path block also needs SERVICE_KEY (only the service role can set is_admin).
//
// Run: `supabase start`, then
//   RUN_INTEGRATION=1 VITE_SUPABASE_URL=… VITE_SUPABASE_ANON_KEY=… \
//   SUPABASE_SERVICE_ROLE_KEY=… npx vitest run tests/integration/admin.integration.test.ts
import { describe, it, expect } from "vitest";
import { ENABLED, SERVICE_KEY, makeUser, serviceClient } from "./_support";

const ADMIN_RPCS = [
  "admin_usage_overview",
  "admin_error_log",
  "admin_provider_health",
  "admin_list_grants",
  "admin_table_sizes",
  "admin_quality_reports",
];

describe.skipIf(!ENABLED)("admin: gating denies non-admins", () => {
  it("is_admin() is false for a normal user", async () => {
    const u = await makeUser();
    const { data, error } = await u.client.rpc("is_admin");
    expect(error).toBeNull();
    expect(data).toBe(false);
  });

  it("every admin-only RPC rejects a non-admin with 42501", async () => {
    const u = await makeUser();
    for (const fn of ADMIN_RPCS) {
      const { error } = await u.client.rpc(fn);
      expect(error, `${fn} should deny a non-admin`).not.toBeNull();
      expect(error?.code).toBe("42501");
    }
  });
});

describe.skipIf(!ENABLED)("admin: quality reports are admin-only end to end", () => {
  it("a non-admin can neither file a report nor touch the table directly", async () => {
    const u = await makeUser();
    // The write RPC gates before it validates its args.
    const { error: rpcErr } = await u.client.rpc("admin_report_quality_issue", {
      p_input: "辛い",
      p_description: "wrong sense",
    });
    expect(rpcErr?.code).toBe("42501");

    // …and the table itself is server-only (no policies, no grants).
    const { error: readErr } = await u.client.from("quality_reports").select("*");
    expect(readErr).not.toBeNull();
    const { error: writeErr } = await u.client
      .from("quality_reports")
      .insert({ input: "辛い", description: "wrong sense" });
    expect(writeErr).not.toBeNull();
  });
});

describe.skipIf(!ENABLED)("admin: is_admin column lock (no self-promotion)", () => {
  it("a user cannot set is_admin on their own row, but can still edit profile fields", async () => {
    const u = await makeUser();
    // Self-promotion attempt → permission denied for the is_admin column.
    const { error: promo } = await u.client.from("users").update({ is_admin: true }).eq("user_id", u.userId);
    expect(promo).not.toBeNull();
    // …and is_admin stays false.
    const { data } = await u.client.from("users").select("is_admin").eq("user_id", u.userId).single();
    expect((data as { is_admin: boolean }).is_admin).toBe(false);
    // A legitimate profile update still succeeds (the column lock didn't over-revoke).
    const { error: ok } = await u.client.from("users").update({ native_language: "EN" }).eq("user_id", u.userId);
    expect(ok).toBeNull();
  });
});

describe.skipIf(!ENABLED)("admin: admin_grant_feature denies non-admins", () => {
  it("a non-admin cannot grant a feature (gated before email resolution)", async () => {
    const u = await makeUser();
    const { error } = await u.client.rpc("admin_grant_feature", { p_email: "x@y.z", p_feature: "voice" });
    expect(error?.code).toBe("42501");
  });
});

describe.skipIf(!ENABLED || !SERVICE_KEY)("admin: feature_grants is append-only", () => {
  // NOTE: is_admin can only be set by the postgres superuser (service_role has no
  // UPDATE on the column — the maximal lock), so the is_admin()=true "admin sees
  // data" path isn't reachable through the PostgREST harness; it's verified out of
  // band. Here we assert the append-only invariant directly: the service role may
  // INSERT a grant but can NEVER UPDATE or DELETE one (the legal never-revoke rule,
  // enforced by REVOKE — not by trusting callers).
  it("service role can INSERT a grant but never UPDATE or DELETE it", async () => {
    const svc = serviceClient();
    if (!svc) return;
    const target = await makeUser();
    const { error: insErr } = await svc.from("feature_grants").insert({ user_id: target.userId, feature: "voice" });
    expect(insErr).toBeNull();
    const { error: updErr } = await svc.from("feature_grants").update({ feature: "x" }).eq("user_id", target.userId);
    expect(updErr).not.toBeNull();
    const { error: delErr } = await svc.from("feature_grants").delete().eq("user_id", target.userId);
    expect(delErr).not.toBeNull();
  });

  it("a normal user cannot write feature_grants at all (read-own only)", async () => {
    const u = await makeUser();
    const { error: insErr } = await u.client.from("feature_grants").insert({ user_id: u.userId, feature: "voice" });
    expect(insErr).not.toBeNull();
  });
});
