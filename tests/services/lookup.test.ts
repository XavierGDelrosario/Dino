import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeWord, FIXTURE_WORDS } from "@test/fixtures";
import { createMockSenseProvider, createMockTranslate } from "@test/mockProviders";

// lookup.ts is READ-only: it surfaces meanings and a display translation but
// never writes to a user's lists. Mock the data + provider boundaries.
vi.mock("@/services/words/repository", () => ({
  findWordTranslations: vi.fn(),
  findWordTranslationsBatch: vi.fn(),
}));
vi.mock("@/services/translation", () => ({
  translate: vi.fn(),
  MAX_TRANSLATION_CONCURRENCY: 6,
}));
vi.mock("@/services/senses", () => ({ resolveSenseProvider: vi.fn() }));

import { findWordTranslations, findWordTranslationsBatch } from "@/services/words/repository";
import { translate } from "@/services/translation";
import { resolveSenseProvider } from "@/services/senses";
import { lookupWord, translateParagraph } from "@/services/lookup";

const mockFind = vi.mocked(findWordTranslations);
const mockFindBatch = vi.mocked(findWordTranslationsBatch);
const mockTranslate = vi.mocked(translate);
const mockResolveProvider = vi.mocked(resolveSenseProvider);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("lookupWord", () => {
  it("returns ALL cached meanings without invoking a sense provider", async () => {
    const meanings = [
      makeWord({ wordId: "ja-takai-1", input: "高い", translation: "high" }),
      makeWord({ wordId: "ja-takai-2", input: "高い", translation: "expensive" }),
    ];
    mockFind.mockResolvedValue(meanings);

    const res = await lookupWord({ input: "高い", targetLang: "EN" });

    expect(res.sourceLang).toBe("JA");
    expect(res.meanings.map((m) => m.translation)).toEqual(["high", "expensive"]);
    expect(mockResolveProvider).not.toHaveBeenCalled();
  });

  it("seeds meanings from the sense provider on a cache miss (multi-sense)", async () => {
    mockFind.mockResolvedValue([]); // nothing cached yet
    // The mock dictionary returns BOTH senses of 高い — the multi-sense path the
    // real MT fallback can't produce.
    mockResolveProvider.mockReturnValue(createMockSenseProvider(FIXTURE_WORDS));

    const res = await lookupWord({ input: "高い", targetLang: "EN" });

    expect(mockResolveProvider).toHaveBeenCalledWith("JA", "EN");
    expect(res.meanings.map((m) => m.translation)).toEqual(["high", "expensive"]);
  });

  it("trims and NFC-normalizes the input", async () => {
    mockFind.mockResolvedValue([makeWord()]);
    const res = await lookupWord({ input: "  猫  ", targetLang: "EN" });
    expect(res.input).toBe("猫");
  });
});

describe("translateParagraph", () => {
  it("translates the whole paragraph display-only (persist:false) and maps each word to its meanings", async () => {
    // The paragraph itself isn't a seeded single word, so give the display-only
    // (persist:false) call a contextual translation; per-word seeding still uses
    // the fixture-backed sense provider below.
    mockTranslate.mockImplementation(async (p) => {
      if (p.persist === false) {
        return { translated: true, translation: "the cat and the dog", word: null };
      }
      return createMockTranslate(FIXTURE_WORDS)(p);
    });
    // 猫 already cached; 犬 missing → seeded via the sense provider.
    mockFindBatch.mockResolvedValue(
      new Map([["猫", [makeWord({ wordId: "ja-neko", input: "猫", translation: "cat" })]]])
    );
    mockResolveProvider.mockReturnValue(createMockSenseProvider(FIXTURE_WORDS));

    const res = await translateParagraph({ input: "猫 犬", targetLang: "EN" });

    // The whole-paragraph call must be display-only.
    expect(mockTranslate).toHaveBeenCalledWith(
      expect.objectContaining({ input: "猫 犬", persist: false })
    );
    expect(res.translated).toBe(true);
    expect(res.sourceLang).toBe("JA");
    expect(res.meanings.get("猫")?.[0].translation).toBe("cat");
    expect(res.meanings.get("犬")?.[0].translation).toBe("dog"); // seeded
    expect(res.tokens.length).toBeGreaterThanOrEqual(2);
  });

  it("falls back to showing the input when the paragraph can't be translated", async () => {
    mockTranslate.mockResolvedValue({ translated: false, translation: null, word: null });
    mockFindBatch.mockResolvedValue(new Map());
    mockResolveProvider.mockReturnValue(createMockSenseProvider([]));

    const res = await translateParagraph({ input: "猫", targetLang: "EN" });
    expect(res.translated).toBe(false);
    expect(res.translation).toBe("猫");
  });
});
