import { describe, it, expect } from "vitest";
import {
  blocksToReadingOrder,
  blocksToText,
  detectDirection,
  joinVerticalLines,
} from "@/services/ocr/readingOrder";
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

describe("vertical reading order (縦書き)", () => {
  // Three columns on a page, as a recognizer might return them: left to right.
  const col = (text: string, x: number, y = 0.05, height = 0.8): OcrBlock => ({
    text,
    x,
    y,
    width: 0.08,
    height,
  });

  it("reads columns right to left", () => {
    const blocks = [col("左", 0.1), col("中", 0.45), col("右", 0.8)];
    expect(blocksToReadingOrder(blocks, "vertical").map((b) => b.text)).toEqual(["右", "中", "左"]);
  });

  it("reads top to bottom within a column, even when it arrives in pieces", () => {
    const blocks = [col("下", 0.8, 0.5, 0.3), col("上", 0.81, 0.05, 0.3), col("次", 0.4)];
    expect(blocksToReadingOrder(blocks, "vertical").map((b) => b.text)).toEqual(["上", "下", "次"]);
  });

  it("joins columns into running text, breaking only after a finished sentence", () => {
    // 学校 wraps across the first two columns; a line break there would split the word.
    const blocks = [col("行った。", 0.2), col("校に", 0.5), col("今日は学", 0.8)];
    expect(blocksToText(blocks, "vertical")).toBe("今日は学校に行った。");
    const two = [col("犬も寝た。", 0.2), col("猫が走った。", 0.8)];
    expect(blocksToText(two, "vertical")).toBe("猫が走った。\n犬も寝た。");
  });

  it("leaves the horizontal default untouched", () => {
    const blocks = [col("右", 0.8), col("左", 0.1)];
    expect(blocksToText(blocks)).toBe("左\n右");
  });
});

describe("joinVerticalLines (the transcript path)", () => {
  it("joins one-line-per-column text, breaking only after a finished sentence", () => {
    expect(joinVerticalLines(["今日は学", "校に行った。", "", " 楽しかった。 "])).toBe(
      "今日は学校に行った。\n楽しかった。",
    );
    expect(joinVerticalLines([])).toBe("");
  });
});

describe("detectDirection", () => {
  // A portrait photo, so a normalized box's shape isn't its pixel shape.
  const page = (blocks: OcrBlock[]) => ({ width: 1000, height: 1500, blocks });
  const TRANSCRIPT = "今日は学校に行った。\n楽しかった。";

  it("is horizontal when the block recognizer read the same text as wide lines", () => {
    const blocks = [b("今日は学校に行った。", 0.1, 0.1, 0.6, 0.04), b("楽しかった。", 0.1, 0.2, 0.4, 0.04)];
    expect(detectDirection(page(blocks), TRANSCRIPT)).toBe("horizontal");
  });

  it("is vertical when the block recognizer found nothing", () => {
    expect(detectDirection(page([]), TRANSCRIPT)).toBe("vertical");
  });

  it("is vertical when the block recognizer found only a little of the text", () => {
    expect(detectDirection(page([b("今日", 0.1, 0.1, 0.1, 0.04)]), TRANSCRIPT)).toBe("vertical");
  });

  it("is vertical when the same text came back as tall column boxes", () => {
    const blocks = [b("今日は学校に行った。", 0.8, 0.05, 0.05, 0.6), b("楽しかった。", 0.6, 0.05, 0.05, 0.4)];
    expect(detectDirection(page(blocks), TRANSCRIPT)).toBe("vertical");
  });

  it("is vertical when the text came back as single-character fragments", () => {
    const blocks = [..."今日は学校に行った楽しかった"].map((c, i) => b(c, 0.8, 0.05 * i, 0.04, 0.03));
    expect(detectDirection(page(blocks), TRANSCRIPT)).toBe("vertical");
  });

  it("is horizontal when there is no transcript to compare against", () => {
    expect(detectDirection(page([b("猫", 0.1, 0.1)]), "")).toBe("horizontal");
  });
});
