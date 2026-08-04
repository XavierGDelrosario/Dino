/**
 * Renders the social-share card (Open Graph / Twitter) to public/og.png.
 *
 * Regenerate after changing the card copy or the brand palette:
 *   node scripts/build-og-image.mjs
 *
 * The output IS committed (unlike public/dict/) — the crawlers LinkedIn, Slack and
 * X use never run JS and never build the app, so the file has to exist at the
 * deployed origin as a plain static asset that index.html's absolute og:image
 * points at. 1200x630 is the size every one of them crops cleanly.
 *
 * Uses the Playwright chromium already installed for the e2e specs; Japanese text
 * renders through the system Hiragino Sans, so this is macOS-shaped by design (it
 * is a one-shot asset build, not part of npm run build).
 */
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "public", "og.png");

// The app's own palette (src/components/common/common.css), with the brand purple
// from favicon.svg (#7C3AED) carrying the logo mark and the headline accent, so the
// card and the site a click-through lands on read as the same product.
//
// Two purples, on purpose: #7C3AED is a FILL colour (it's what the favicon block is,
// and white sits on it cleanly), but as TEXT on the near-black #0f1115 background it
// only reaches ~3.3:1 contrast. The headline uses the lighter #A78BFA tint instead
// (~7:1) so it stays legible in a feed thumbnail. Same hue family, different job.
const html = `
<!doctype html>
<meta charset="utf-8" />
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 1200px; height: 630px; }
  body {
    background: #0f1115;
    color: #e8eaed;
    font-family: "Inter", "Helvetica Neue", Helvetica, Arial, sans-serif;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    padding: 64px 76px;
    position: relative;
    overflow: hidden;
  }
  /* Soft accent glow, bottom-right — keeps the flat dark field from reading as a
     broken image on LinkedIn's white feed. */
  .glow {
    position: absolute; right: -180px; bottom: -260px;
    width: 760px; height: 760px; border-radius: 50%;
    background: radial-gradient(circle, rgba(124,58,237,0.30) 0%, rgba(124,58,237,0) 68%);
  }
  .top { display: flex; align-items: center; gap: 20px; }
  .mark {
    width: 68px; height: 68px; border-radius: 18px;
    background: #7C3AED; color: #FFFFFF;
    font-size: 45px; font-weight: 800; letter-spacing: -1px;
    display: flex; align-items: center; justify-content: center;
  }
  .wordmark { font-size: 40px; font-weight: 800; letter-spacing: 6px; }
  .kanji { font-size: 23px; color: #9aa0ab; letter-spacing: 4px; margin-top: 3px; }
  h1 {
    font-size: 52px; line-height: 1.18; font-weight: 700;
    letter-spacing: -1.4px; max-width: 1050px; position: relative;
  }
  h1 .hl { color: #A78BFA; }
  p.sub {
    margin-top: 20px; font-size: 24px; line-height: 1.45;
    color: #9aa0ab; max-width: 900px; position: relative;
  }
  /* A miniature of the reader — the app's most recognisable surface: content words
     coloured grey (no entry) / blue (addable) / red-to-green (how well you know it),
     particles left as plain text. */
  .reader {
    position: relative;
    background: #1a1d24; border: 1px solid #2c313c; border-radius: 14px;
    padding: 24px 30px; display: flex; align-items: baseline; gap: 4px;
    font-size: 34px; letter-spacing: 1px;
  }
  .reader span { padding: 2px 5px; border-radius: 7px; }
  .p  { color: #9aa0ab; }
  .g  { color: #7f8794; background: rgba(154,160,171,0.10); }
  .b  { color: #6ea8fe; background: rgba(110,168,254,0.14); }
  .r  { color: #f0715f; background: rgba(240,113,95,0.14); }
  .gr { color: #57c98a; background: rgba(87,201,138,0.14); }
</style>
<div class="glow"></div>

<div class="top">
  <div class="mark">D</div>
  <div>
    <div class="wordmark">DINO</div>
    <div class="kanji">大脳</div>
  </div>
</div>

<div>
  <h1>Read the Japanese you care about &mdash;<br /><span class="hl">every word becomes a flashcard.</span></h1>
  <p class="sub">Paste a paragraph or open an article. DINO breaks it into real words with
  readings and meanings, then feeds the ones you don&rsquo;t know into spaced repetition.</p>
</div>

<div class="reader">
  <span class="gr">昨日</span><span class="p">は</span><span class="b">友達</span><span class="p">と</span><span class="r">映画</span><span class="p">を</span><span class="gr">見</span><span class="p">に</span><span class="b">行った</span><span class="p">。</span>
</div>
`;

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1200, height: 630 },
  deviceScaleFactor: 1,
});
await page.setContent(html, { waitUntil: "load" });
await page.screenshot({ path: OUT });
await browser.close();

console.log(`✓ wrote ${path.relative(ROOT, OUT)} (1200x630)`);
