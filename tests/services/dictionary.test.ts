import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeWord, makeUserWord } from "@test/fixtures";
import { createMockTranslate } from "@test/mockProviders";

// dictionary.ts orchestrates repository (dictionary reads) + userWords (save) +
// translation. Mock those boundaries so the test exercises the real
// Find-or-Create decision logic.
vi.mock("@/services/words/repository", () => ({ findCachedWord: vi.fn() }));
vi.mock("@/services/words/userWords", () => ({ saveDictionaryWord: vi.fn() }));
vi.mock("@/services/translation", () => ({
  translate: vi.fn(),
  MAX_TRANSLATION_CONCURRENCY: 6,
}));

import { findCachedWord } from "@/services/words/repository";
import { saveDictionaryWord } from "@/services/words/userWords";
import { translate } from "@/services/translation";
import { addWordToList, addWordsToList } from "@/services/dictionary";

const mockFindCached = vi.mocked(findCachedWord);
const mockSave = vi.mocked(saveDictionaryWord);
const mockTranslate = vi.mocked(translate);

beforeEach(() => {
  vi.clearAllMocks();
  mockSave.mockResolvedValue(makeUserWord());
});

describe("addWordToList — guards", () => {
  it("throws on empty / whitespace input", async () => {
    await expect(
      addWordToList({ userId: "u", input: "   ", targetLang: "JA" })
    ).rejects.toThrow("Cannot add an empty word");
  });

  it("throws when resolved source equals target", async () => {
    // "hello" detects as EN; target EN → nothing to translate.
    await expect(
      addWordToList({ userId: "u", input: "hello", targetLang: "EN", sourceLang: "EN" })
    ).rejects.toThrow(/both/i);
  });
});

describe("addWordToList — cache hit", () => {
  it("saves the cached dictionary word without calling translate", async () => {
    const cached = makeWord({ wordId: "ja-neko", input: "猫", translation: "cat" });
    mockFindCached.mockResolvedValue(cached);

    const res = await addWordToList({ userId: "u", input: "猫", targetLang: "EN" });

    expect(mockTranslate).not.toHaveBeenCalled();
    expect(mockSave).toHaveBeenCalledWith({ userId: "u", word: cached, listId: undefined });
    expect(res).toMatchObject({
      input: "猫",
      translation: "cat",
      sourceLang: "JA",
      targetLang: "EN",
      translated: true,
      saved: true,
      fromCache: true,
      word: cached,
    });
  });
});

describe("addWordToList — cache miss", () => {
  it("translates, then saves the backend-created dictionary word", async () => {
    mockFindCached.mockResolvedValue(null);
    mockTranslate.mockImplementation(createMockTranslate());

    const res = await addWordToList({ userId: "u", input: "犬", targetLang: "EN" });

    expect(mockTranslate).toHaveBeenCalledOnce();
    expect(mockSave).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u", word: expect.objectContaining({ wordId: "ja-inu" }) })
    );
    expect(res).toMatchObject({
      translation: "dog",
      translated: true,
      saved: true,
      fromCache: false,
    });
    expect(res.word?.wordId).toBe("ja-inu");
  });

  it("shows the input and persists nothing when the provider has no result", async () => {
    mockFindCached.mockResolvedValue(null);
    mockTranslate.mockResolvedValue({ translated: false, translation: null, word: null });

    const res = await addWordToList({ userId: "u", input: "ねこねこ", targetLang: "EN" });

    expect(res).toMatchObject({
      input: "ねこねこ",
      translation: "ねこねこ", // falls back to showing the input
      translated: false,
      saved: false,
      fromCache: false,
    });
    expect(res.word).toBeUndefined();
    expect(mockSave).not.toHaveBeenCalled(); // no cache poisoning
  });

  it("trims and NFC-normalizes the input before use", async () => {
    mockFindCached.mockResolvedValue(null);
    mockTranslate.mockImplementation(createMockTranslate());

    const res = await addWordToList({ userId: "u", input: "  猫  ", targetLang: "EN" });
    expect(res.input).toBe("猫");
  });
});

describe("addWordsToList — batch", () => {
  it("de-duplicates (NFC + trim) and keeps first-occurrence order", async () => {
    mockFindCached.mockResolvedValue(null);
    mockTranslate.mockImplementation(createMockTranslate());

    const res = await addWordsToList({
      userId: "u",
      inputs: ["猫", " 猫 ", "犬"], // duplicate 猫 collapses
      targetLang: "EN",
    });

    expect(res.map((r) => r.input)).toEqual(["猫", "犬"]);
    expect(mockTranslate).toHaveBeenCalledTimes(2); // not billed twice for 猫
  });
});
