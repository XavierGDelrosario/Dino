import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeWord } from "@test/fixtures";

vi.mock("@/services/words/repository", () => ({ insertUnverifiedWord: vi.fn() }));
vi.mock("@/services/words/userLibrary", () => ({
  saveWordToUserLibrary: vi.fn(),
  removeWordFromList: vi.fn(),
}));

import { insertUnverifiedWord } from "@/services/words/repository";
import { saveWordToUserLibrary, removeWordFromList } from "@/services/words/userLibrary";
import { saveCustomWord } from "@/services/words/customWords";

const mockInsert = vi.mocked(insertUnverifiedWord);
const mockSave = vi.mocked(saveWordToUserLibrary);
const mockRemove = vi.mocked(removeWordFromList);

beforeEach(() => {
  vi.clearAllMocks();
  mockInsert.mockResolvedValue(makeWord({ wordId: "new-word" }));
  mockSave.mockResolvedValue({ isNewForUser: true });
});

describe("saveCustomWord — validation", () => {
  it.each([
    ["empty word", { input: "  ", translation: "cat" }],
    ["empty translation", { input: "猫", translation: " " }],
  ])("throws when %s", async (_label, { input, translation }) => {
    await expect(
      saveCustomWord({ userId: "u", input, translation, sourceLang: "JA", targetLang: "EN" })
    ).rejects.toThrow(/required/i);
    expect(mockInsert).not.toHaveBeenCalled();
  });
});

describe("saveCustomWord — add", () => {
  it("inserts an unverified word, links it, and does not detach anything", async () => {
    const res = await saveCustomWord({
      userId: "u",
      input: "  猫  ",
      translation: "  cat  ",
      sourceLang: "JA",
      targetLang: "EN",
    });

    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({ input: "猫", translation: "cat", createdBy: "u" })
    );
    expect(mockSave).toHaveBeenCalledWith({ userId: "u", wordId: "new-word", listId: undefined });
    expect(mockRemove).not.toHaveBeenCalled();
    expect(res).toEqual({ word: makeWord({ wordId: "new-word" }), isNewForUser: true });
  });
});

describe("saveCustomWord — edit", () => {
  it("detaches the replaced word from the list", async () => {
    await saveCustomWord({
      userId: "u",
      input: "猫",
      translation: "cat",
      sourceLang: "JA",
      targetLang: "EN",
      listId: "list-1",
      replacesWordId: "old-word",
    });

    expect(mockRemove).toHaveBeenCalledWith({ listId: "list-1", wordId: "old-word" });
  });

  it("does not detach when the replacement resolves to the same word id", async () => {
    mockInsert.mockResolvedValue(makeWord({ wordId: "same" }));
    await saveCustomWord({
      userId: "u",
      input: "猫",
      translation: "cat",
      sourceLang: "JA",
      targetLang: "EN",
      listId: "list-1",
      replacesWordId: "same",
    });
    expect(mockRemove).not.toHaveBeenCalled();
  });
});
