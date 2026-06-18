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
// Partial-mock language: keep the real resolveSourceLanguage / AUTO_DETECT, but
// stub the kuromoji-backed analyze() so these stay fast unit tests (no ~12MB
// dictionary load). The real engine is covered in language/analyze.test.ts.
vi.mock("@/services/language", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/language")>()),
  analyze: vi.fn(),
}));

import { findWordTranslations, findWordTranslationsBatch } from "@/services/words/repository";
import { translate } from "@/services/translation";
import { resolveSenseProvider } from "@/services/senses";
import { analyze } from "@/services/language";
import { lookupWord, translateParagraph } from "@/services/lookup";

const mockFind = vi.mocked(findWordTranslations);
const mockFindBatch = vi.mocked(findWordTranslationsBatch);
const mockTranslate = vi.mocked(translate);
const mockResolveProvider = vi.mocked(resolveSenseProvider);
const mockAnalyze = vi.mocked(analyze);

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

  it("no-context lookup: each homograph sense carries its OWN reading from words (never swapped)", async () => {
    // 辛い is two JMdict entries → two words rows, each with its own reading.
    // Single-word lookup has no sentence context, so the `words` reading IS the
    // furigana — kuromoji is not consulted here. からい must stay on spicy.
    mockFind.mockResolvedValue([
      makeWord({ input: "辛い", translation: "spicy", inputReading: "からい" }),
      makeWord({ input: "辛い", translation: "painful", inputReading: "つらい" }),
    ]);

    const res = await lookupWord({ input: "辛い", targetLang: "EN" });

    const spicy = res.meanings.find((m) => m.translation === "spicy");
    const painful = res.meanings.find((m) => m.translation === "painful");
    expect(spicy?.inputReading).toBe("からい");
    expect(painful?.inputReading).toBe("つらい");
    expect(mockResolveProvider).not.toHaveBeenCalled(); // cache hit, no kuromoji/provider
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
    // Analysis is mocked: two tokens, each carrying a (best-effort) reading.
    mockAnalyze.mockResolvedValue([
      { text: "猫", start: 0, end: 1, reading: "ねこ", lemma: "猫" },
      { text: "犬", start: 2, end: 3, reading: "いぬ", lemma: "犬" },
    ]);

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
    // Per-token readings propagate from analysis to the tokens.
    expect(res.tokens.find((t) => t.text === "猫")?.reading).toBe("ねこ");
  });

  it("overrides kuromoji with the unambiguous reading already on the looked-up word", async () => {
    mockTranslate.mockResolvedValue({ translated: true, translation: "now", word: null });
    // The dictionary sense (looked up for its meaning) already carries the
    // authoritative reading — one distinct reading → unambiguous → override.
    mockFindBatch.mockResolvedValue(
      new Map([["今", [makeWord({ input: "今", translation: "now", inputReading: "いま" })]]])
    );
    mockResolveProvider.mockReturnValue(createMockSenseProvider([]));
    // kuromoji misreads 今 in isolation as こん; lemma 今.
    mockAnalyze.mockResolvedValue([{ text: "今", start: 0, end: 1, reading: "こん", lemma: "今" }]);

    const res = await translateParagraph({ input: "今", targetLang: "EN" });
    expect(res.tokens.find((t) => t.text === "今")?.reading).toBe("いま"); // overridden
  });

  it("keeps kuromoji's reading when the dictionary lists SEVERAL readings (ambiguous → trust context)", async () => {
    mockTranslate.mockResolvedValue({ translated: true, translation: "spicy", word: null });
    // 辛い: からい (spicy) vs つらい (painful) — two distinct readings → ambiguous.
    mockFindBatch.mockResolvedValue(
      new Map([
        ["辛い", [
          makeWord({ input: "辛い", translation: "spicy", inputReading: "からい" }),
          makeWord({ input: "辛い", translation: "painful", inputReading: "つらい" }),
        ]],
      ])
    );
    mockResolveProvider.mockReturnValue(createMockSenseProvider([]));
    mockAnalyze.mockResolvedValue([{ text: "辛い", start: 0, end: 2, reading: "からい", lemma: "辛い" }]);

    const res = await translateParagraph({ input: "辛い", targetLang: "EN" });
    expect(res.tokens.find((t) => t.text === "辛い")?.reading).toBe("からい"); // kuromoji's context guess kept
  });

  it("keeps the kuromoji reading when the word has no dictionary entry", async () => {
    mockTranslate.mockResolvedValue({ translated: true, translation: "cat", word: null });
    mockFindBatch.mockResolvedValue(new Map()); // not in words
    mockResolveProvider.mockReturnValue(createMockSenseProvider([]));
    mockAnalyze.mockResolvedValue([{ text: "猫", start: 0, end: 1, reading: "ねこ", lemma: "猫" }]);

    const res = await translateParagraph({ input: "猫", targetLang: "EN" });
    expect(res.tokens.find((t) => t.text === "猫")?.reading).toBe("ねこ");
  });

  it("conjugated form (行った): meaning resolves via the LEMMA, furigana keeps kuromoji's SURFACE reading (cache hit)", async () => {
    mockTranslate.mockResolvedValue({ translated: true, translation: "went", word: null });
    // 行く is cached (keyed by the lemma); 行った is the surface in the sentence.
    mockFindBatch.mockResolvedValue(
      new Map([["行く", [makeWord({ input: "行く", translation: "to go", inputReading: "いく" })]]])
    );
    mockResolveProvider.mockReturnValue(createMockSenseProvider([]));
    // kuromoji: surface 行った, lemma 行く, surface reading いった.
    mockAnalyze.mockResolvedValue([{ text: "行った", start: 0, end: 3, reading: "いった", lemma: "行く" }]);

    const res = await translateParagraph({ input: "行った", targetLang: "EN" });

    // Meaning found via the LEMMA, then re-keyed under the surface text.
    expect(res.meanings.get("行った")?.[0].translation).toBe("to go");
    // Reading is the SURFACE reading from kuromoji — NOT the lemma reading いく.
    expect(res.tokens.find((t) => t.text === "行った")?.reading).toBe("いった");
  });

  it("conjugated form (行った): same result on a cache MISS (lemma seeded via the sense provider)", async () => {
    mockTranslate.mockResolvedValue({ translated: true, translation: "went", word: null });
    mockFindBatch.mockResolvedValue(new Map()); // 行く not cached
    mockResolveProvider.mockReturnValue(
      createMockSenseProvider([makeWord({ input: "行く", translation: "to go", inputReading: "いく" })])
    );
    mockAnalyze.mockResolvedValue([{ text: "行った", start: 0, end: 3, reading: "いった", lemma: "行く" }]);

    const res = await translateParagraph({ input: "行った", targetLang: "EN" });

    expect(res.meanings.get("行った")?.[0].translation).toBe("to go"); // seeded via lemma
    expect(res.tokens.find((t) => t.text === "行った")?.reading).toBe("いった"); // surface reading kept
  });

  it("falls back to showing the input when the paragraph can't be translated", async () => {
    mockTranslate.mockResolvedValue({ translated: false, translation: null, word: null });
    mockFindBatch.mockResolvedValue(new Map());
    mockResolveProvider.mockReturnValue(createMockSenseProvider([]));
    mockAnalyze.mockResolvedValue([{ text: "猫", start: 0, end: 1, reading: "ねこ", lemma: "猫" }]);

    const res = await translateParagraph({ input: "猫", targetLang: "EN" });
    expect(res.translated).toBe(false);
    expect(res.translation).toBe("猫");
  });
});
