import { describe, it, expect } from "vitest";
import { blocksToReadingOrder, blocksToText } from "@/services/ocr/readingOrder";
import type { OcrBlock } from "@/services/ocr/types";

// helper: a block at (x,y) with a default line height
const b = (text: string, x: number, y: number, w = 0.3, h = 0.05): OcrBlock => ({ text, x, y, width: w, height: h });

describe("blocksToReadingOrder (horizontal)", () => {
  it("orders top→bottom, then left→right within a row", () => {
    // deliberately shuffled input
    const blocks = [b("B", 0.6, 0.10), b("C", 0.1, 0.30), b("A", 0.1, 0.10), b("D", 0.6, 0.30)];
    expect(blocksToReadingOrder(blocks).map((x) => x.text)).toEqual(["A", "B", "C", "D"]);
  });

  it("groups blocks that vertically overlap into the same row", () => {
    // A and B are on the same line (y within half a line height), B is to the right
    const blocks = [b("B", 0.55, 0.105), b("A", 0.05, 0.10)];
    expect(blocksToReadingOrder(blocks).map((x) => x.text)).toEqual(["A", "B"]);
  });

  it("joins reading-order text one block per line, trimming/dropping empties", () => {
    const blocks = [b("世界", 0.1, 0.30), b("  ", 0.1, 0.20), b("こんにちは", 0.1, 0.10)];
    expect(blocksToText(blocks)).toBe("こんにちは\n世界");
  });

  it("handles an empty input", () => {
    expect(blocksToReadingOrder([])).toEqual([]);
    expect(blocksToText([])).toBe("");
  });
});
