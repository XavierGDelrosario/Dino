import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeWord } from "@test/fixtures";

vi.mock("@/services/translation", () => ({ translate: vi.fn() }));

import { translate } from "@/services/translation";
import { mtFallbackProvider } from "@/services/senses/mtFallback";

const mockTranslate = vi.mocked(translate);

beforeEach(() => vi.clearAllMocks());

describe("mtFallbackProvider", () => {
  it("returns ALL senses when the edge function provides them (JMdict multi-sense)", async () => {
    const senses = [
      makeWord({ wordId: "ja-takai-1", input: "高い", translation: "high" }),
      makeWord({ wordId: "ja-takai-2", input: "高い", translation: "expensive" }),
    ];
    mockTranslate.mockResolvedValue({
      translated: true,
      translation: "high",
      word: senses[0],
      words: senses,
    });

    expect(await mtFallbackProvider("高い", "JA", "EN")).toEqual(senses);
  });

  it("falls back to the single `word` when no `words` array is present", async () => {
    const word = makeWord({ wordId: "ja-neko" });
    mockTranslate.mockResolvedValue({ translated: true, translation: "cat", word });

    expect(await mtFallbackProvider("猫", "JA", "EN")).toEqual([word]);
  });

  it("returns [] when nothing was translated/cached", async () => {
    mockTranslate.mockResolvedValue({ translated: false, translation: null, word: null, words: [] });
    expect(await mtFallbackProvider("猫", "JA", "EN")).toEqual([]);
  });
});
