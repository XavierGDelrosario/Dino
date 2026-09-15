// The palette contract, checked against the stylesheet itself.
//
// A light theme fails in a way unit tests of components can't see: one token that
// only exists in the dark block, or one component that kept a hex literal, and that
// screen is unreadable in the other theme while everything else looks fine. Both
// halves are mechanical, so both are pinned here.
//
// (1) every token the dark :root defines has a light counterpart — a token added to
//     one block only is the exact shape of that bug;
// (2) the load-bearing colour SCALES (the confidence ramp the reader paints known
//     words with, the addable blue, the handwriting ink) appear nowhere else as
//     literals, because a literal is correct in exactly one theme.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const COMMON_CSS = "src/components/common/common.css";
const css = readFileSync(COMMON_CSS, "utf8");

/** The declarations inside one selector's block. */
function tokensIn(selector: string): string[] {
  const start = css.indexOf(selector + " {");
  expect(start, `${selector} not found in ${COMMON_CSS}`).toBeGreaterThan(-1);
  const block = css.slice(start, css.indexOf("\n}", start));
  return [...block.matchAll(/^\s*(--[\w-]+):/gm)].map((m) => m[1]);
}

// Theme-INDEPENDENT tokens: they carry no colour, so one definition serves both.
const SHARED_ONLY = new Set(["--radius"]);

describe("theme palette", () => {
  it("defines every colour token in both the dark and the light block", () => {
    const dark = tokensIn(":root").filter((t) => !SHARED_ONLY.has(t));
    const light = new Set(tokensIn(':root[data-theme="light"]'));
    expect(dark.filter((t) => !light.has(t))).toEqual([]);
  });

  it("has no light-only token (which would fall back to the dark value silently)", () => {
    const dark = new Set(tokensIn(":root"));
    expect(tokensIn(':root[data-theme="light"]').filter((t) => !dark.has(t))).toEqual([]);
  });
});

function sourceFiles(dir: string, re: RegExp): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path, re));
    else if (re.test(entry.name)) out.push(path);
  }
  return out;
}

// The dark-theme values of the scales that MUST come from a token. If one of these
// shows up outside common.css, that surface has opted out of the light theme.
const DARK_ONLY_LITERALS = [
  "#ff6b6b", "#ff9f5a", "#ffd166", "#c9d65a", "#7fce6f", "#3ecb6c", // confidence ramp
  "#5b9dff", // --word-new (addable)
  "#0b0d11", // --hw-pad (drawing pad)
];

describe("colour scales stay tokenized", () => {
  it("is not re-hard-coded outside the palette", () => {
    const offenders: string[] = [];
    for (const file of [...sourceFiles("src", /\.css$/), ...sourceFiles("src", /\.tsx?$/)]) {
      if (file.endsWith("common.css")) continue;
      const source = readFileSync(file, "utf8")
        .toLowerCase()
        // Comments explain the history; they paint nothing.
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "")
        // A var() fallback (`var(--word-new, #5b9dff)`) is fine — the token wins
        // whenever it exists, and it always does. Only a BARE literal opts out.
        .replace(/var\(\s*--[\w-]+\s*,[^)]*\)/g, "var()");
      for (const hex of DARK_ONLY_LITERALS) {
        if (source.includes(hex)) offenders.push(`${file}: ${hex}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
