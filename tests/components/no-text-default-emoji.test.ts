// Guard against a real bug (2026-07-13): the Lists trash button used the bare 🗑
// (U+1F5D1 WASTEBASKET), and a user saw it render as a "1F5D1" hex box instead of an
// icon — the button looked broken though the delete worked fine.
//
// WHY it happens: a handful of emoji have Emoji_Presentation = No, meaning their
// DEFAULT rendering is TEXT, not emoji. The browser therefore looks them up in a text
// font — and text fonts don't carry astral-plane pictographs like U+1F5D1, so you get
// the missing-glyph box. (Emoji_Presentation = Yes chars, e.g. 🌐 U+1F310, are safe:
// they go to the colour-emoji font by default.) A char only renders as emoji if it is
// followed by U+FE0F (VS16) or the font happens to have it.
//
// The fix is icons.tsx (SVG, no font dependency). This test keeps it fixed: it fails
// if a text-default emoji reappears in the UI without VS16. If you deliberately want
// one, add U+FE0F after it — or better, add an SVG to components/common/icons.tsx.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Emoji with Emoji_Presentation = No that a UI would plausibly reach for. Not the
// full Unicode set — the ones that actually bite. The astral-plane ones (> U+FFFF)
// are the dangerous ones; the BMP dingbats usually survive in text fonts.
const TEXT_DEFAULT_EMOJI: Record<number, string> = {
  0x1f5d1: "WASTEBASKET 🗑 — the one that broke",
  0x1f5d2: "SPIRAL NOTE PAD",
  0x1f5d3: "SPIRAL CALENDAR",
  0x1f587: "LINKED PAPERCLIPS",
  0x1f58a: "LOWER LEFT BALLPOINT PEN",
  0x1f5a5: "DESKTOP COMPUTER",
  0x1f5c2: "CARD INDEX DIVIDERS",
  0x1f5dd: "OLD KEY",
  0x1f5f3: "BALLOT BOX WITH BALLOT",
  0x1f570: "MANTELPIECE CLOCK",
};

const VS16 = 0xfe0f;

function uiSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...uiSourceFiles(path));
    else if (/\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

describe("UI icons", () => {
  it("uses no text-default emoji (they render as a hex box in fonts that lack them)", () => {
    const offenders: string[] = [];

    for (const file of uiSourceFiles("src")) {
      const source = readFileSync(file, "utf8");
      const chars = [...source];
      chars.forEach((char, i) => {
        const cp = char.codePointAt(0)!;
        const name = TEXT_DEFAULT_EMOJI[cp];
        if (!name) return;
        if (chars[i + 1]?.codePointAt(0) === VS16) return; // VS16 forces emoji presentation
        offenders.push(`${file}: U+${cp.toString(16).toUpperCase()} ${name}`);
      });
    }

    expect(offenders).toEqual([]);
  });
});
