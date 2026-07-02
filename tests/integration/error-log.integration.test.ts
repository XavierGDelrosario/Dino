// =========================================================
// LIVE integration coverage of the `error_log` audit sink (migration 20260706)
// that the edge function's recordError() writes to on a failing path
// (translate_batch_failed / words_upsert_failed / translate_handler_crashed).
//
// The edge's INTERNAL failure paths can't be forced deterministically over HTTP
// (they need a broken DB / provider mid-request), so this asserts the CONTRACT
// recordError depends on, end-to-end against real Postgres:
//   • the service role can INSERT a recordError-shaped row and read it back
//     (the exact write recordError performs);
//   • clients (anon/authenticated) can neither SELECT nor INSERT (RLS lockdown);
//   • the row is IMMUTABLE — even the service role can't UPDATE/DELETE it;
//   • the admin_error_log read RPC denies a non-admin (42501).
//
// Gated behind RUN_INTEGRATION; the service-role blocks self-skip without
// SUPABASE_SERVICE_ROLE_KEY. To run:
//   supabase start
//   RUN_INTEGRATION=1 \
//   VITE_SUPABASE_URL=http://127.0.0.1:54321 \
//   VITE_SUPABASE_ANON_KEY=<local-anon-key> \
//   SUPABASE_SERVICE_ROLE_KEY=<local-service-role-key> \
//   npm run test:integration -- error-log
// =========================================================
import { describe, it, expect } from "vitest";
import { ENABLED, SERVICE_KEY, makeUser, serviceClient } from "./_support";

// Unique marker so parallel/rerun rows don't collide and we can find OUR row.
const MARKER = `test_recordError_${crypto.randomUUID()}`;

// The exact column set recordError() inserts (index.ts).
const recordErrorRow = {
  error_code: MARKER,
  source: "translate.single",
  user_id: null as string | null,
  input: "猫",
  detail: "words upsert failed: simulated",
};

describe.skipIf(!ENABLED || !SERVICE_KEY)("error_log: service-role write path (recordError)", () => {
  it("accepts the recordError insert and reads it back", async () => {
    const svc = serviceClient()!;
    const { error: insErr } = await svc.from("error_log").insert(recordErrorRow);
    expect(insErr).toBeNull();

    const { data, error } = await svc
      .from("error_log")
      .select("error_code, source, input, detail, occurred_at")
      .eq("error_code", MARKER);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data![0]).toMatchObject({
      error_code: MARKER,
      source: "translate.single",
      input: "猫",
    });
    // occurred_at is server-defaulted.
    expect(data![0].occurred_at).toBeTruthy();
  });

  it("is IMMUTABLE — the service role cannot UPDATE or DELETE a logged row", async () => {
    const svc = serviceClient()!;
    const { error: updErr } = await svc
      .from("error_log")
      .update({ detail: "tampered" })
      .eq("error_code", MARKER);
    expect(updErr).not.toBeNull(); // UPDATE revoked from service_role

    const { error: delErr } = await svc
      .from("error_log")
      .delete()
      .eq("error_code", MARKER);
    expect(delErr).not.toBeNull(); // DELETE revoked from service_role
  });
});

describe.skipIf(!ENABLED)("error_log: clients are locked out (RLS / no grants)", () => {
  it("an anonymous client cannot SELECT the audit log", async () => {
    const u = await makeUser();
    const { error } = await u.client.from("error_log").select("error_code").limit(1);
    expect(error).not.toBeNull(); // no SELECT grant to anon/authenticated
  });

  it("an anonymous client cannot INSERT into the audit log", async () => {
    const u = await makeUser();
    const { error } = await u.client
      .from("error_log")
      .insert({ error_code: "forged", source: "client", input: null, detail: null });
    expect(error).not.toBeNull(); // no INSERT grant → clients can't forge audit rows
  });

  it("admin_error_log denies a non-admin (42501)", async () => {
    const u = await makeUser();
    const { error } = await u.client.rpc("admin_error_log", {});
    expect(error).not.toBeNull();
    expect(error?.code).toBe("42501");
  });
});
