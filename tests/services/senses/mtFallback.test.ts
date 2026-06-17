import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeWord } from "@test/fixtures";

vi.mock("@/services/translation", () => ({ translate: vi.fn() }));

import { translate } from "@/services/translation";
import { mtFallbackProvider } from "@/services/senses/mtFallback";

const mockTranslate = vi.mocked(translate);

beforeEach(() => vi.clearAllMocks());

describe("mtFallbackProvider", () => {
  it("returns the single cached word as a one-element sense list", async () => {
    const word = makeWord({ wordId: "ja-neko" });
    mockTranslate.mockResolvedValue({ translated: true, translation: "cat", word });

    const senses = await mtFallbackProvider("猫", "JA", "EN");
    expect(senses).toEqual([word]); // single-sense "freeze"
  });

  it("returns [] when nothing was translated/cached", async () => {
    mockTranslate.mockResolvedValue({ translated: false, translation: null, word: null });
    expect(await mtFallbackProvider("猫", "JA", "EN")).toEqual([]);
  });
});
