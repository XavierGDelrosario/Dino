// =========================================================
// LIVE coverage of the REAL `supabase.functions.invoke` path (Native-runtime
// audit, TODO "Integration test via REAL functions.invoke (not raw fetch)").
//
// WHY THIS EXISTS — the gap it closes:
//   `invoke` never runs for real anywhere else in the suite. The bug that
//   motivated this (a CapacitorHttp regression that HUNG `functions.invoke` on
//   iOS, stuck on "Translating…") slipped through because every layer was tested
//   with the others stubbed:
//     • services/translation/client.test.ts   MOCKS supabase.functions.invoke
//     • translate-edge.integration.test.ts     hits the edge via RAW fetch (so the
//                                               supabase-js invoke client — headers,
//                                               body (de)serialization, auth-token
//                                               attachment, non-2xx→error mapping —
//                                               is never exercised)
//     • e2e-smoke.mjs                           MOCKS Supabase entirely
//   This spec drives the SAME `supabase.functions.invoke` the app uses, both at
//   the raw SDK seam AND through the real client.ts wrapper (translate /
//   translateBatch), against a running local edge.
//
//   (It still can't reproduce the CapacitorHttp layer itself — that needs the
//   native-simulator smoke, a separate TODO — but it makes the invoke request/
//   response CONTRACT real instead of mocked, which is where every native bug
//   this session actually lived.)
//
// PREREQUISITES (same as translate-edge.integration.test.ts):
//   1. supabase start
//   2. supabase functions serve translate --no-verify-jwt
//   3. JMdict ingested (or seeded) — content assertions self-skip without it.
//
// RUN:
//   RUN_INTEGRATION=1 \
//   VITE_SUPABASE_URL=http://127.0.0.1:54321 \
//   VITE_SUPABASE_ANON_KEY=<anon> \
//   npm run test:integration -- translate-invoke
// =========================================================
import { describe, it, expect, beforeAll } from "vitest";
import { URL, ANON, ENABLED, makeUser, type TestUser } from "./_support";
import type { TranslationResult } from "@/services/translation/client";

const FN = `${URL}/functions/v1/translate`;

// `supabase functions serve` cold-starts the Deno runtime on the first request
// (boot + remote imports), which can exceed a test's default timeout. Absorb it
// ONCE with a generous budget so every test below runs against a warm edge.
async function warmEdge() {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(FN, { headers: { Authorization: `Bearer ${ANON}` } });
      if (res.status === 200) return;
    } catch { /* edge not up yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

// ---------------------------------------------------------------------------
// Layer 1 — the raw supabase-js SDK seam. A real authed client's
// `functions.invoke` (NOT raw fetch): this is the exact call the app makes.
// ---------------------------------------------------------------------------
describe.skipIf(!ENABLED)("edge: translate via real supabase.functions.invoke", () => {
  let user: TestUser;

  beforeAll(async () => {
    await warmEdge();
    // A real anonymous session → invoke carries the user JWT (an attributable
    // `sub`, exactly like the app after ensureSession()), so the metered path is
    // reachable and auth-header attachment is genuinely exercised.
    user = await makeUser();
  }, 60_000);

  it("returns { data, error:null } for a JA→EN word (no throw, unlike raw fetch)", async () => {
    const { data, error } = await user.client.functions.invoke<TranslationResult>("translate", {
      body: { input: "猫", sourceLang: "JA", targetLang: "EN" },
    });
    expect(error).toBeNull();
    expect(data).not.toBeNull();
    // Contract holds regardless of ingest: `translated` is always present.
    expect(typeof data!.translated).toBe("boolean");
    if (!data!.translated) return; // JMdict not ingested (no MT key) → skip content
    expect(data!.word?.input).toBe("猫");
    expect(data!.words?.length).toBeGreaterThan(0);
  }, 30_000);

  it("batch invoke returns one result entry per input", async () => {
    const { data, error } = await user.client.functions.invoke<{
      results?: Array<{ input: string; translated: boolean }>;
    }>("translate", { body: { inputs: ["猫", "犬"], sourceLang: "JA", targetLang: "EN" } });
    expect(error).toBeNull();
    // Shape holds even when JMdict isn't ingested (each entry translated:false).
    expect(data!.results?.map((r) => r.input)).toEqual(["猫", "犬"]);
  });

  it("surfaces a deliberate 4xx as `error` (not `data`) — source === target", async () => {
    // supabase-js maps a non-2xx to `error` (FunctionsHttpError) rather than
    // throwing. client.ts's wrapper relies on exactly this to distinguish a
    // deliberate 4xx (surface now) from a transient failure (retry). Proving it
    // over the REAL invoke — the mocked unit test can only simulate it.
    const { data, error } = await user.client.functions.invoke("translate", {
      body: { input: "x", sourceLang: "EN", targetLang: "EN" },
    });
    expect(error).not.toBeNull();
    expect(data).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — the actual app wrapper (services/translation/client.ts) end-to-end.
// This runs invokeTranslate → supabase.functions.invoke → result mapping, i.e.
// the literal production code path, over the live edge. Imported dynamically so
// the singleton config/supabaseClient (which createClient()s at import and needs
// VITE_SUPABASE_* — real only under integration) never loads for the default
// unit gate. The suite is skipped when !ENABLED, so these bodies don't run then.
// ---------------------------------------------------------------------------
describe.skipIf(!ENABLED)("edge: translate() app-wrapper end-to-end", () => {
  let translate: typeof import("@/services/translation/client").translate;
  let translateBatch: typeof import("@/services/translation/client").translateBatch;

  beforeAll(async () => {
    await warmEdge();
    // The singleton client the wrapper closes over. Give it a real session so its
    // invoke carries a JWT, mirroring the app after ensureSession().
    const { supabase } = await import("@/config/supabaseClient");
    await supabase.auth.signInAnonymously();
    const client = await import("@/services/translation/client");
    translate = client.translate;
    translateBatch = client.translateBatch;
  }, 60_000);

  it("translate() resolves a JA→EN word through the real invoke wrapper", async () => {
    const res = await translate({ input: "猫", sourceLang: "JA", targetLang: "EN" });
    expect(typeof res.translated).toBe("boolean");
    if (!res.translated) return; // not ingested → skip content
    expect(res.word?.input).toBe("猫");
    expect(res.words?.length).toBeGreaterThan(0);
  }, 30_000);

  it("translateBatch() returns a Map keyed by the input term", async () => {
    const map = await translateBatch({ inputs: ["猫", "犬"], sourceLang: "JA", targetLang: "EN" });
    expect(map.has("猫")).toBe(true);
    expect(map.has("犬")).toBe(true);
    expect(Array.isArray(map.get("猫"))).toBe(true); // empty array when not ingested
  });

  it("translate() THROWS (maps error→ServiceError) on a deliberate 4xx", async () => {
    // source === target 400s at the edge; supabase-js reports it as `error`; the
    // wrapper (non-transient) rethrows via toServiceError. The whole chain, real.
    await expect(
      translate({ input: "x", sourceLang: "EN", targetLang: "EN" }),
    ).rejects.toThrow();
  });
});
