// The pre-paint theme resolver in index.html, checked against the module it mirrors.
//
// index.html stamps <html data-theme> BEFORE first paint, because React mounts too
// late — a light-mode user got a flash of the dark palette on every load. That means
// the storage key, the media-query polarity and the two theme-colour hexes exist
// TWICE, in two runtimes, with nothing linking them.
//
// The drift is invisible where you'd look for it: in dev the app corrects itself a
// few hundred ms later, so the only symptom is a flash of the wrong palette on a cold
// production load — which is the exact bug the script was added to prevent. This repo's
// answer to a hand-mirror is a test (see projection-version.test.ts, theme-palette.test.ts);
// this is that test for this mirror.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { STORAGE_KEY, THEME_COLOR } from "@/services/theme";

const html = readFileSync("index.html", "utf8");
const script = html.slice(html.indexOf("<script>"), html.indexOf("</script>"));

describe("index.html pre-paint theme script", () => {
  it("reads the SAME localStorage key as services/theme", () => {
    expect(script).toContain(`localStorage.getItem("${STORAGE_KEY}")`);
  });

  // Polarity matters and is easy to invert: the module tests prefers-color-scheme:
  // LIGHT and falls back to dark, so a script testing `dark` would resolve every
  // no-preference visitor the other way.
  it("tests the same prefers-color-scheme direction, with dark as the fallback", () => {
    expect(script).toContain('matchMedia("(prefers-color-scheme: light)")');
    expect(script).not.toContain("prefers-color-scheme: dark");
    expect(script).toMatch(/:\s*"dark"/);
  });

  it("carries the same theme-colour hexes as THEME_COLOR", () => {
    // The document's own <meta> is the dark default; the script swaps in the light one.
    expect(html).toContain(`<meta name="theme-color" content="${THEME_COLOR.dark}" />`);
    expect(script).toContain(`"${THEME_COLOR.light}"`);
  });

  it("stamps both the attribute the palette selects on and colorScheme", () => {
    expect(script).toContain("document.documentElement.dataset.theme");
    expect(script).toContain("colorScheme");
  });
});
