// E2E smoke test against the PRODUCTION BUILD (Rollup output), run in a real
// browser. This is the gate that catches prod-build-only regressions that the
// unit suite (esbuild/jsdom) can't — most importantly the kuromoji dictionary
// loader: a bad bundle makes `analyze()` throw inside its async loader, the
// build() callback never fires, and every Japanese paragraph hangs forever. That
// shipped once (zlibjs `Gunzip` undefined) because nothing exercised the built
// app in a browser. Now it does.
//
// No backend needed: Supabase (auth + REST + the translate edge fn) is mocked via
// Playwright route interception, so the REAL client bundle + REAL kuromoji run
// against canned responses. Build with a matching dummy VITE_SUPABASE_URL.
//
// Usage: node scripts/e2e-smoke.mjs [baseUrl]   (default http://localhost:4173)
import pw from "playwright";
const { chromium } = pw;

const BASE = process.argv[2] || process.env.E2E_BASE_URL || "http://localhost:4173";
// MUST match the VITE_SUPABASE_URL the bundle was built with (see scripts/e2e.sh).
const SUPA_HOST = "e2e.test.supabase.co";

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const FAKE_JWT = `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url({
  sub: "00000000-0000-0000-0000-000000000001",
  role: "authenticated",
  aud: "authenticated",
  is_anonymous: true,
  exp: 9999999999,
})}.sig`;
const USER = {
  id: "00000000-0000-0000-0000-000000000001",
  aud: "authenticated",
  role: "authenticated",
  email: "",
  phone: "",
  is_anonymous: true,
  app_metadata: {},
  user_metadata: {},
  identities: [],
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};
const SESSION = {
  access_token: FAKE_JWT,
  token_type: "bearer",
  expires_in: 3600,
  expires_at: 9999999999,
  refresh_token: "fake-refresh",
  user: USER,
};

const KUROMOJI_ERR = /Gunzip|invalid file signature|Failed to fetch dynamically imported module|morphological analysis unavailable/i;

const fail = (msg) => { console.error("E2E FAIL:", msg); process.exitCode = 1; };

const browser = await chromium.launch();
const page = await browser.newPage();
const pageErrors = [];
const consoleErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));
page.on("console", (m) => { if (m.type() === "error" || KUROMOJI_ERR.test(m.text())) consoleErrors.push(m.text()); });

// Mock every Supabase call (auth, REST, edge fn) so the real bundle boots + the
// paragraph reader resolves without a server.
await page.route(`**://${SUPA_HOST}/**`, async (route) => {
  const req = route.request();
  const url = req.url();
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" };
  const json = (body, status = 200) =>
    route.fulfill({ status, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify(body) });
  if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });

  if (url.includes("/auth/v1/")) {
    if (url.includes("/user")) return json(USER);
    if (url.includes("/logout")) return json({});
    return json(SESSION); // signup / anonymous / token refresh
  }
  if (url.includes("/functions/v1/translate")) {
    let post = {};
    try { post = req.postDataJSON() ?? {}; } catch { /* noop */ }
    if (Array.isArray(post.inputs)) {
      const results = post.inputs.map((input) => {
        const word = {
          wordId: `w-${input}`, input, translation: "x", sourceLang: "JA", targetLang: "EN",
          inputReading: null, translationReading: null, partOfSpeech: ["n"], frequency: 1,
          difficultyOverride: null, jmdictEntryId: "1", jmdictSensePos: 0, isVerified: true,
        };
        return { input, translated: true, translation: "x", word, words: [word] };
      });
      return json({ results });
    }
    return json({ translated: true, translation: "This is a book", word: null, words: [] });
  }
  return json([]); // /rest/v1/words, /rest/v1/user_words, /rest/v1/users, …
});

try {
  await page.goto(BASE, { waitUntil: "networkidle", timeout: 60000 });
  // Wait for the session + warmJapaneseAnalyzer (kuromoji load) to settle.
  await page.waitForSelector("textarea", { timeout: 30000 });
  await page.waitForTimeout(4000);

  // 1. Drive the paragraph reader through REAL kuromoji. A fresh guest's OUTPUT
  // defaults to the learning language (JA), so typing Japanese is input==output and
  // intentionally ECHOES with no reader. To exercise the kuromoji reader we study
  // Japanese with the explanation in English: set the target/output (the 2nd langbar
  // select) to English, then type Japanese → input JA ≠ output EN, so the reader
  // studies the typed Japanese. This guards the kuromoji loader hang (the regression
  // that shipped: a bad bundle makes analyze() hang and the reader never renders).
  await page.locator(".langbar select").nth(1).selectOption("EN");
  const ta = page.locator("textarea").first();
  await ta.click();
  await ta.pressSequentially("これは本です", { delay: 15 });
  await page.locator(".translate__submit .btn").click();

  let rendered = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    if (await page.$(".reader")) { rendered = true; break; }
    if (await page.$(".review__error")) break;
    await page.waitForTimeout(400);
  }

  if (!rendered) {
    const diag = await page.evaluate(() => ({
      err: document.querySelector(".review__error")?.textContent?.slice(0, 160),
      out: document.querySelector(".translate__out")?.innerText?.slice(0, 80),
      btn: document.querySelector(".translate__submit .btn")?.textContent,
      body: document.body.innerText.slice(0, 160).replace(/\n/g, " "),
    }));
    console.error("DIAG:", JSON.stringify(diag));
    console.error("pageErrors:", JSON.stringify(pageErrors.slice(0, 5)));
    console.error("consoleErrors:", JSON.stringify(consoleErrors.slice(0, 8)));
    fail("paragraph reader did not render within 30s (kuromoji hang or flow error)");
  } else {
    const info = await page.evaluate(() => ({
      text: document.querySelector(".reader")?.innerText || "",
      tokens: document.querySelectorAll(".reader .tok").length,
    }));
    if (info.tokens < 1) fail(`reader rendered but kuromoji produced no tokens (${JSON.stringify(info)})`);
    else if (!info.text.includes("本")) fail(`reader text missing expected content: ${JSON.stringify(info)}`);
    else console.log(`OK: reader rendered, ${info.tokens} kuromoji tokens, text="${info.text.slice(0, 40)}"`);
  }

  // 2. HARD guard: no kuromoji-class error anywhere (this is the regression we shipped).
  const kErrors = [...pageErrors, ...consoleErrors].filter((m) => KUROMOJI_ERR.test(m));
  if (kErrors.length) fail(`kuromoji-class error(s): ${[...new Set(kErrors)].join(" | ")}`);
  else console.log("OK: no kuromoji-class errors");
} catch (e) {
  fail(String(e).split("\n")[0]);
} finally {
  await browser.close();
}

if (process.exitCode) console.error("\n=== E2E smoke FAILED ===");
else console.log("\n=== E2E smoke PASSED ===");
