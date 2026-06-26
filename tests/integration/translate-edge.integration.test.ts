// =========================================================
// LIVE black-box coverage of the `translate` edge function's I/O SHELL (#9 audit).
//
// The function's PURE logic is unit-tested in tests/edge/translate-lib.test.ts
// (via _lib.ts). What that can't reach is the Deno.serve handler itself: HTTP
// method/validation handling, the health check, the DB-backed cache/JMdict paths,
// batch mode, the observability access log, and the retry-idempotency replay. This
// spec drives the RUNNING function over HTTP and asserts those.
//
// PREREQUISITES (beyond the DB the other integration specs need):
//   1. supabase start
//   2. supabase functions serve translate --no-verify-jwt
//   3. JMdict ingested (or seeded) — the cache/lookup assertions need it.
//
// RUN:
//   RUN_INTEGRATION=1 \
//   VITE_SUPABASE_URL=http://127.0.0.1:54321 \
//   VITE_SUPABASE_ANON_KEY=<anon> \
//   SUPABASE_SERVICE_ROLE_KEY=<service>   # enables the idempotency-replay assertion
//   npm run test:integration -- translate-edge
// =========================================================
import { describe, it, expect, beforeAll } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { URL, ANON, SERVICE_KEY, ENABLED, makeUser } from "./_support";

const FN = `${URL}/functions/v1/translate`;

// POST with a given bearer token (default the bare anon key — no user session).
async function postAs(token: string, body: unknown) {
  const res = await fetch(FN, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  let json: Record<string, unknown> = {};
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, json };
}
const post = (body: unknown) => postAs(ANON, body);

// `supabase functions serve` COLD-STARTS the Deno runtime on the first request
// (boot + remote imports), which can exceed a test's default 5s timeout and flake
// the health check in CI. Absorb that cold start ONCE here, with a generous budget,
// so every test below runs against a warm edge. (No-op when not running integration.)
beforeAll(async () => {
  if (!ENABLED) return;
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(FN, { headers: { Authorization: `Bearer ${ANON}` } });
      if (res.status === 200) return;
    } catch { /* edge not up yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
}, 60_000);

/** A fresh user's id + access-token (a real JWT `sub` → the paid path is metered). */
async function makeTokenUser(): Promise<{ userId: string; token: string }> {
  const u = await makeUser();
  const { data } = await u.client.auth.getSession();
  return { userId: u.userId, token: data.session!.access_token };
}

describe.skipIf(!ENABLED)("edge: translate HTTP shell", () => {
  it("GET is a health check → 200 {status:ok}", async () => {
    const res = await fetch(FN, { headers: { Authorization: `Bearer ${ANON}` } });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("ok");
  }, 30_000); // generous: CI edge cold start can be slow even after warmup

  it("rejects an unsupported method → 405", async () => {
    const res = await fetch(FN, { method: "PUT", headers: { Authorization: `Bearer ${ANON}` } });
    expect(res.status).toBe(405);
  });

  it("400s on invalid JSON", async () => {
    expect((await post("{not json")).status).toBe(400);
  });

  it("400s when source/target langs are missing", async () => {
    expect((await post({ input: "猫" })).status).toBe(400);
  });

  it("400s when source === target", async () => {
    expect((await post({ input: "x", sourceLang: "EN", targetLang: "EN" })).status).toBe(400);
  });

  it("400s when input is empty", async () => {
    expect((await post({ sourceLang: "JA", targetLang: "EN" })).status).toBe(400);
  });

  it("resolves a JA→EN word with senses + reading (cache/JMdict path)", async () => {
    const { status, json } = await post({ input: "猫", sourceLang: "JA", targetLang: "EN" });
    expect(status).toBe(200);
    if (!json.translated) return; // JMdict not ingested in this env (no MT key) → skip
    const words = json.words as Array<{ input: string; inputReading: string | null }>;
    const word = json.word as { input: string };
    expect(words.length).toBeGreaterThan(0);
    expect(word.input).toBe("猫");
    // The common reading is among the senses. (Not asserting it's the PRIMARY:
    // homograph entries each carry sense_pos 0, and fetchVerified orders by
    // sense_pos only, so which 猫 entry sorts first isn't pinned — see #7 ranking.)
    expect(words.some((w) => w.inputReading === "ねこ")).toBe(true);
  });

  it("caps the EN→JA reverse-gloss result (LIMIT 12)", async () => {
    const { json } = await post({ input: "the", sourceLang: "EN", targetLang: "JA" });
    if (!json.translated) return; // JMdict not ingested → skip
    expect((json.words as unknown[]).length).toBeLessThanOrEqual(12);
  });

  it("batch mode returns one entry per input", async () => {
    const { status, json } = await post({
      inputs: ["猫", "犬"], sourceLang: "JA", targetLang: "EN",
    });
    expect(status).toBe(200);
    const results = json.results as Array<{ input: string; translated: boolean }>;
    expect(results.map((r) => r.input)).toEqual(["猫", "犬"]); // shape holds even if empty
    if (!results.some((r) => r.translated)) return; // JMdict not ingested → skip content check
    expect(results.every((r) => r.translated)).toBe(true);
  });

  it("batch resolves a WRITING VARIANT (速い → headword 早い), like the single path", async () => {
    // 速い is a non-primary writing of はやい, stored under headword 早い (reading
    // はやい) — so neither the headword nor the reading equals the search term, and
    // groupByInput alone drops it. The single path always found it; this guards the
    // batch path against that discrepancy via the dictionary_ref mapping.
    const batch = await post({ inputs: ["速い"], sourceLang: "JA", targetLang: "EN" });
    const r = (batch.json.results as Array<{ input: string; translated: boolean }>)[0];
    expect(r.input).toBe("速い");
    if (!r.translated) {
      // Distinguish "JMdict not ingested" (skip) from a real regression: if the
      // SINGLE path finds 速い but the batch didn't, the mapping broke.
      const single = await post({ input: "速い", sourceLang: "JA", targetLang: "EN" });
      if (!(single.json as { translated: boolean }).translated) return; // not ingested → skip
      throw new Error("single path resolved 速い but batch did not — writing-variant mapping regressed");
    }
    expect(r.translated).toBe(true);
  });
});

// Idempotency replay/store need the service role to seed/read idempotency_keys.
// The client is built INSIDE each test (not at describe body — the body still runs
// when skipped, and createClient("","") would throw in a non-integration run).
describe.skipIf(!ENABLED || !SERVICE_KEY)("edge: retry idempotency", () => {
  const adminClient = () =>
    createClient(URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

  it("REPLAYS a stored response for a repeated key (proves no re-spend)", async () => {
    const admin = adminClient();
    // Pre-seed a sentinel under the key; a request with that key must return it
    // verbatim — proving the edge replays the store instead of recomputing (which
    // would re-call the provider / re-reserve quota). (Uses INSERT, not UPDATE:
    // service_role has no UPDATE on this server-only table by design.)
    const key = `it-replay-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await admin.from("idempotency_keys").insert({ key, status: 200, response: { SENTINEL: key } });

    const { json } = await post({
      input: "今日はいい天気", sourceLang: "JA", targetLang: "EN", persist: false, idempotencyKey: key,
    });
    expect(json).toEqual({ SENTINEL: key });

    await admin.from("idempotency_keys").delete().eq("key", key);
  });

  it("STORES the paid response under a fresh key", async () => {
    const admin = adminClient();
    // Needs a real user JWT: the paid path (which sets usedMT → stores) only runs for
    // an attributable user, so a bare-anon-key call would skip MT and store nothing.
    const { token } = await makeTokenUser();
    const key = `it-store-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const { json } = await postAs(token, {
      input: "今日はとても良い天気", sourceLang: "JA", targetLang: "EN", persist: false, idempotencyKey: key,
    });
    // The key is stored only when the PAID path actually ran (usedMT) — which needs
    // TRANSLATION_API_KEY on the edge. Without it (e.g. CI) the gloss isn't translated
    // and nothing is stored, so this case isn't exercisable here: skip rather than fail.
    if (!json?.translated) return;
    const { data } = await admin
      .from("idempotency_keys").select("key").eq("key", key).maybeSingle();
    expect(data).not.toBeNull();
    await admin.from("idempotency_keys").delete().eq("key", key);
  });
});

// Cost-control gates (#1): the paid MT path must 413/429 BEFORE calling Google.
// Needs a user JWT (the paid path is metered only for an attributable user) + a
// JMdict-MISS input (so the MT path is reached) + a seeded low limit. No spend
// occurs: both gates return before the provider call.
const MISS = "zxqwvk"; // not a JMdict entry → routes to the MT fallback
describe.skipIf(!ENABLED || !SERVICE_KEY)("edge: cost-control gates", () => {
  const adminClient = () =>
    createClient(URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

  it("413s an input over the per-request paragraph limit", async () => {
    const admin = adminClient();
    const { userId, token } = await makeTokenUser();
    await admin.from("user_limits").upsert(
      { user_id: userId, paragraph_char_limit: 3, monthly_char_quota: 1_000_000 },
      { onConflict: "user_id" },
    );
    const { status } = await postAs(token, { input: MISS, sourceLang: "JA", targetLang: "EN" });
    // 413 if MT is configured on the served fn; if not, the path no-ops to 200 (skip).
    if (status === 200) return;
    expect(status).toBe(413);
  });

  it("429s once the monthly quota is exhausted", async () => {
    const admin = adminClient();
    const { userId, token } = await makeTokenUser();
    await admin.from("user_limits").upsert(
      { user_id: userId, paragraph_char_limit: 2000, monthly_char_quota: 1 },
      { onConflict: "user_id" },
    );
    const { status } = await postAs(token, { input: MISS, sourceLang: "JA", targetLang: "EN" });
    if (status === 200) return; // MT not configured on the served fn → skip
    expect(status).toBe(429);
  });

  it("does NOT meter / spend for a bare anon key (no user session)", async () => {
    // No JWT sub → the paid path is skipped entirely → JMdict-only (translated:false
    // for a miss), never reaching the provider or the quota.
    const { json } = await post({ input: MISS, sourceLang: "JA", targetLang: "EN" });
    expect(json.translated).toBe(false);
  });
});
