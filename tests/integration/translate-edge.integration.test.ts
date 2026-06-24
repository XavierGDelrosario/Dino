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
import { describe, it, expect } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { URL, ANON, SERVICE_KEY, ENABLED } from "./_support";

const FN = `${URL}/functions/v1/translate`;

async function post(body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(FN, {
    method: "POST",
    headers: { Authorization: `Bearer ${ANON}`, "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  let json: Record<string, unknown> = {};
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, json };
}

describe.skipIf(!ENABLED)("edge: translate HTTP shell", () => {
  it("GET is a health check → 200 {status:ok}", async () => {
    const res = await fetch(FN, { headers: { Authorization: `Bearer ${ANON}` } });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("ok");
  });

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
    const key = `it-store-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await post({
      input: "今日はとても良い天気", sourceLang: "JA", targetLang: "EN", persist: false, idempotencyKey: key,
    });
    const { data } = await admin
      .from("idempotency_keys").select("key").eq("key", key).maybeSingle();
    expect(data).not.toBeNull();
    await admin.from("idempotency_keys").delete().eq("key", key);
  });
});
