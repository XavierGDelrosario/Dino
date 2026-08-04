// The sentence gloss cache. Its whole reason to exist is that the two ways to buy
// English — tapping one sentence's punctuation, and pressing "Show translation" for
// the whole text — must not bill for the same line twice.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/services/translation/client", () => ({ translateSegments: vi.fn() }));

import { translateSegments } from "@/services/translation/client";
import {
  glossSentences,
  getCachedGloss,
  setCachedGloss,
  __clearGlossCache,
} from "@/services/translation/sentenceCache";

const mockSegments = vi.mocked(translateSegments);
const gloss = (segments: string[]) =>
  glossSentences({ segments, sourceLang: "JA", targetLang: "EN" });

describe("glossSentences", () => {
  beforeEach(() => {
    __clearGlossCache();
    mockSegments.mockReset();
    // Echo back a recognisable gloss per input, in order.
    mockSegments.mockImplementation(async ({ segments }) => segments.map((s) => `EN(${s})`));
  });

  it("requests uncached sentences and remembers them", async () => {
    expect(await gloss(["猫が好き。"])).toEqual(["EN(猫が好き。)"]);
    expect(getCachedGloss("猫が好き。", "JA", "EN")).toBe("EN(猫が好き。)");
  });

  it("a second ask costs NOTHING — the whole point", async () => {
    await gloss(["猫が好き。"]);
    mockSegments.mockClear();
    expect(await gloss(["猫が好き。"])).toEqual(["EN(猫が好き。)"]);
    expect(mockSegments).not.toHaveBeenCalled();
  });

  it("a paragraph press only pays for what tapping didn't already buy", async () => {
    await gloss(["一つ目。"]); // tapped one sentence
    mockSegments.mockClear();

    const all = await gloss(["一つ目。", "二つ目。", "三つ目。"]);
    // Only the two it didn't hold went out.
    expect(mockSegments.mock.calls[0][0].segments).toEqual(["二つ目。", "三つ目。"]);
    expect(all).toEqual(["EN(一つ目。)", "EN(二つ目。)", "EN(三つ目。)"]);
  });

  it("sends a repeated sentence ONCE and fills both slots", async () => {
    const out = await gloss(["同じ文。", "違う文。", "同じ文。"]);
    expect(mockSegments.mock.calls[0][0].segments).toEqual(["同じ文。", "違う文。"]);
    expect(out[0]).toBe("EN(同じ文。)");
    expect(out[2]).toBe("EN(同じ文。)"); // the repeat resolved from the cache
  });

  it("keys on the LANGUAGE PAIR, not the text alone", async () => {
    setCachedGloss("猫が好き。", "JA", "EN", "cached");
    expect(getCachedGloss("猫が好き。", "JA", "KO")).toBeUndefined();
  });

  it("normalizes whitespace and Unicode form, so the same sentence is one entry", async () => {
    await gloss(["猫が好き。"]);
    mockSegments.mockClear();
    expect(await gloss(["  猫が好き。  "])).toEqual(["EN(猫が好き。)"]);
    expect(mockSegments).not.toHaveBeenCalled();
  });

  it("returns null for a sentence the provider couldn't translate, and doesn't cache it", async () => {
    mockSegments.mockResolvedValue([""]);
    expect(await gloss(["謎。"])).toEqual([null]);
    expect(getCachedGloss("謎。", "JA", "EN")).toBeUndefined();
  });

  it("a paragraph gloss and a single tap are the SAME purchase, either order", async () => {
    // Both `translateParagraph`'s gloss and the reader's punctuation tap route here,
    // so whichever happens first pays and the other is free. Going direct to the
    // client from one of them was a real double-spend.
    await gloss(["一つ目。", "二つ目。"]); // e.g. Translate glossed the paragraph
    mockSegments.mockClear();
    expect(await gloss(["二つ目。"])).toEqual(["EN(二つ目。)"]); // then a tap
    expect(mockSegments).not.toHaveBeenCalled();
  });

  it("makes no request at all when everything is held", async () => {
    setCachedGloss("一つ目。", "JA", "EN", "first");
    setCachedGloss("二つ目。", "JA", "EN", "second");
    expect(await gloss(["一つ目。", "二つ目。"])).toEqual(["first", "second"]);
    expect(mockSegments).not.toHaveBeenCalled();
  });
});
