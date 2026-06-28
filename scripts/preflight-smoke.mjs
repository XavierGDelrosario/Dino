// Post-deploy PREFLIGHT SMOKE against the LIVE `translate` edge function.
//
// Closes the seam every native bug this project shipped lived in: `invoke` is
// never exercised end-to-end (client tests mock it, the integration spec hits the
// edge with raw fetch where the LOCAL Kong gateway rewrites CORS to "*", and
// e2e-smoke mocks Supabase entirely). So a broken ALLOWED_ORIGINS or an
// unreachable function only shows up on a real device — which is exactly the
// CapacitorHttp regression that hung `functions.invoke` on iOS with no test to
// catch it. This runs against PROD and asserts the two things that matter:
//
//   1. CORS PREFLIGHT — for each origin we ship to (the Pages URL + the native
//      `capacitor://localhost`), an OPTIONS request gets that exact origin echoed
//      back (not "*", not "null"). Plus a NEGATIVE check: an unlisted origin must
//      NOT be echoed — proving ALLOWED_ORIGINS is actually set and restrictive
//      (an unset value silently degrades to "*", which this fails on).
//   2. AUTHED POST → 200 — sign in anonymously (the real guest flow) for a real
//      JWT, then POST a JMdict word and assert a 200 with a translation. This is
//      the live-`invoke` path nothing else covers; a hang/5xx/CORS-strip fails it.
//
// Reads VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY from the env (same names as
// deploy-prod.sh and the integration suite).
//
// Usage:
//   VITE_SUPABASE_URL=https://<ref>.supabase.co \
//   VITE_SUPABASE_ANON_KEY=<anon> \
//   node scripts/preflight-smoke.mjs https://dino-86y.pages.dev
//
// Web origins come from argv (or PREFLIGHT_ORIGINS, comma-separated);
// `capacitor://localhost` (the native origin) is always checked.
import { createClient } from "@supabase/supabase-js";

const URL = process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
const ANON = process.env.VITE_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY ?? "";
if (!URL || !ANON) {
  console.error("error: set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (the LIVE prod values).");
  process.exit(2);
}
const FN = `${URL.replace(/\/$/, "")}/functions/v1/translate`;

// The native origin is always part of the shipped surface; web origins are passed in.
const NATIVE_ORIGIN = "capacitor://localhost";
const passed = [
  ...process.argv.slice(2),
  ...(process.env.PREFLIGHT_ORIGINS ?? "").split(","),
].map((s) => s.trim()).filter(Boolean);
const origins = [...new Set([...passed, NATIVE_ORIGIN])];
if (!passed.some((o) => o !== NATIVE_ORIGIN)) {
  console.warn("warn: no web origin given — checking capacitor://localhost only.");
  console.warn("      pass your Pages URL, e.g. node scripts/preflight-smoke.mjs https://<you>.pages.dev");
}
// An origin that must NEVER be allowed — proves the allow-list is enforced, not "*".
const UNLISTED = "https://preflight-smoke.invalid";

let failures = 0;
const ok = (msg) => console.log(`OK:   ${msg}`);
const fail = (msg) => { failures++; console.error(`FAIL: ${msg}`); };

// fetch with a hard timeout so a hung edge fails fast instead of hanging the run.
async function fetchT(url, init = {}, ms = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// 1. CORS preflight per origin.
for (const origin of origins) {
  try {
    const res = await fetchT(FN, {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization, content-type",
      },
    });
    const acao = res.headers.get("access-control-allow-origin");
    if (acao === origin) ok(`preflight ${origin} → echoed`);
    else if (acao === "*") fail(`preflight ${origin} → "*" (ALLOWED_ORIGINS unset? CORS is wide open)`);
    else fail(`preflight ${origin} → "${acao}" (origin NOT allowed; add it to ALLOWED_ORIGINS)`);
  } catch (e) {
    fail(`preflight ${origin} → ${String(e).split("\n")[0]}`);
  }
}

// 1b. Negative: an unlisted origin must not be echoed (catches a "*" default).
try {
  const res = await fetchT(FN, {
    method: "OPTIONS",
    headers: { Origin: UNLISTED, "Access-Control-Request-Method": "POST" },
  });
  const acao = res.headers.get("access-control-allow-origin");
  if (acao === UNLISTED) fail(`unlisted origin was ECHOED — allow-list not enforced`);
  else if (acao === "*") fail(`unlisted origin → "*" (ALLOWED_ORIGINS unset; CORS is wide open)`);
  else ok(`unlisted origin → "${acao}" (allow-list enforced)`);
} catch (e) {
  fail(`negative preflight → ${String(e).split("\n")[0]}`);
}

// 2. Authed POST → 200 with a translation (the live `invoke` path).
try {
  const supabase = createClient(URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await supabase.auth.signInAnonymously();
  const token = data?.session?.access_token;
  if (error || !token) {
    fail(`anonymous sign-in failed: ${error?.message ?? "no session"} (is anon sign-in enabled?)`);
  } else {
    const origin = passed.find((o) => o !== NATIVE_ORIGIN) ?? NATIVE_ORIGIN;
    const res = await fetchT(FN, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Origin: origin,
      },
      body: JSON.stringify({ input: "猫", sourceLang: "JA", targetLang: "EN" }),
    });
    let json = {};
    try { json = await res.json(); } catch { /* non-JSON */ }
    if (res.status !== 200) {
      fail(`authed POST → ${res.status} ${JSON.stringify(json).slice(0, 120)}`);
    } else if (res.headers.get("access-control-allow-origin") !== origin) {
      fail(`authed POST 200 but CORS not echoed for ${origin} (browser/WebView would block the read)`);
    } else if (!json.translated) {
      // 200 + reachable, but no dictionary hit — likely JMdict not ingested on this
      // project. The invoke path works; flag rather than fail the deploy gate.
      console.warn(`warn: authed POST 200 but translated=false for 猫 (JMdict ingested on this project?)`);
      ok(`authed POST → 200, CORS echoed (translation empty — see warning)`);
    } else {
      ok(`authed POST → 200, translated "${String(json.translation).slice(0, 40)}", CORS echoed`);
    }
  }
} catch (e) {
  fail(`authed POST → ${String(e).split("\n")[0]}`);
}

console.log(failures ? `\n=== PREFLIGHT SMOKE FAILED (${failures}) ===` : "\n=== PREFLIGHT SMOKE PASSED ===");
process.exit(failures ? 1 : 0);
