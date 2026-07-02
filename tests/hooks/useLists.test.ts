// @vitest-environment jsdom
// Hook spec for useLists — the Lists screen driver. Covers the behaviors added
// when load-more became a display control: the WHOLE list is streamed into the
// client cache in batches, and mutations PATCH that cache in place instead of
// re-pulling every page. The service boundary is fully mocked; USER_WORDS_PAGE_SIZE
// is mocked small (2) so multi-batch streaming is exercised with a few fixtures.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { makeUserWord } from "@test/fixtures";

vi.mock("@/services/lists", () => ({
  listUserLists: vi.fn(),
  createList: vi.fn(),
  renameList: vi.fn(),
  deleteList: vi.fn(),
}));
vi.mock("@/services/lookup", () => ({ lookupWord: vi.fn() }));
vi.mock("@/services/words/userWords", () => ({
  USER_WORDS_PAGE_SIZE: 2, // small: a "full page" is 2, so 3 rows = 2 batches
  getAllUserWords: vi.fn(),
  getUserWordsInList: vi.fn(),
  saveDictionaryWord: vi.fn(),
  createCustomWord: vi.fn(),
  editUserWord: vi.fn(),
  deleteUserWord: vi.fn(),
  addUserWordToList: vi.fn(),
  removeUserWordFromList: vi.fn(),
}));

import { useLists } from "@/hooks/useLists";
import { listUserLists } from "@/services/lists";
import {
  getAllUserWords,
  getUserWordsInList,
  createCustomWord,
  editUserWord,
  deleteUserWord,
  removeUserWordFromList,
} from "@/services/words/userWords";

const mockListLists = vi.mocked(listUserLists);
const mockGetAll = vi.mocked(getAllUserWords);
const mockGetInList = vi.mocked(getUserWordsInList);
const mockCreateCustom = vi.mocked(createCustomWord);
const mockEdit = vi.mocked(editUserWord);
const mockDelete = vi.mocked(deleteUserWord);
const mockUntag = vi.mocked(removeUserWordFromList);

const uw1 = makeUserWord({ userWordId: "u1", input: "一", translation: "one" });
const uw2 = makeUserWord({ userWordId: "u2", input: "二", translation: "two" });
const uw3 = makeUserWord({ userWordId: "u3", input: "三", translation: "three" });

/** Mock getAllUserWords to serve pages keyed by offset (mirrors the DB range read). */
function serveAllPages(pages: Record<number, ReturnType<typeof makeUserWord>[]>) {
  mockGetAll.mockImplementation(({ offset = 0 }) => Promise.resolve(pages[offset] ?? []));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockListLists.mockResolvedValue([]);
  mockGetInList.mockResolvedValue([]);
});

describe("useLists — full-list streaming load", () => {
  it("streams every page into the cache and flips fullyLoaded when done", async () => {
    serveAllPages({ 0: [uw1, uw2], 2: [uw3] }); // page 0 full (2) → page 2 partial (1) → stop
    const { result } = renderHook(() => useLists("user-1"));

    await waitFor(() => expect(result.current.fullyLoaded).toBe(true));
    expect(result.current.status).toBe("ready");
    expect(result.current.words.map((w) => w.userWordId)).toEqual(["u1", "u2", "u3"]);
    // offset 0 then offset 2 — the batched range reads.
    expect(mockGetAll).toHaveBeenCalledWith(expect.objectContaining({ offset: 0 }));
    expect(mockGetAll).toHaveBeenCalledWith(expect.objectContaining({ offset: 2 }));
  });

  it("stops after one page when the first page isn't full", async () => {
    serveAllPages({ 0: [uw1] }); // 1 < 2 → no second fetch
    const { result } = renderHook(() => useLists("user-1"));

    await waitFor(() => expect(result.current.fullyLoaded).toBe(true));
    expect(result.current.words).toHaveLength(1);
    expect(mockGetAll).toHaveBeenCalledTimes(1);
  });

  it("surfaces an error and sets status=error on load failure", async () => {
    mockGetAll.mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() => useLists("user-1"));

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.error).toBeTruthy();
  });
});

describe("useLists — mutations patch the cache in place (no re-pull)", () => {
  async function loadedHook() {
    serveAllPages({ 0: [uw1, uw2], 2: [] }); // 2 rows loaded, fully
    const hook = renderHook(() => useLists("user-1"));
    await waitFor(() => expect(hook.result.current.fullyLoaded).toBe(true));
    return hook;
  }

  it("delete removes the row without re-fetching the list", async () => {
    const { result } = await loadedHook();
    const callsAfterLoad = mockGetAll.mock.calls.length;
    mockDelete.mockResolvedValue(undefined);

    await act(async () => {
      await result.current.deleteWord("u1");
    });

    expect(result.current.words.map((w) => w.userWordId)).toEqual(["u2"]);
    expect(mockGetAll).toHaveBeenCalledTimes(callsAfterLoad); // no reload
  });

  it("edit replaces the row in place (keeps the new meaning)", async () => {
    const { result } = await loadedHook();
    const callsAfterLoad = mockGetAll.mock.calls.length;
    mockEdit.mockResolvedValue(makeUserWord({ userWordId: "u1", input: "一", translation: "ONE!" }));

    await act(async () => {
      await result.current.editWord("u1", "ONE!");
    });

    expect(result.current.words.find((w) => w.userWordId === "u1")?.translation).toBe("ONE!");
    expect(result.current.words).toHaveLength(2);
    expect(mockGetAll).toHaveBeenCalledTimes(callsAfterLoad);
  });

  it("addCustomWord prepends the new word without re-fetching", async () => {
    const { result } = await loadedHook();
    const callsAfterLoad = mockGetAll.mock.calls.length;
    mockCreateCustom.mockResolvedValue(makeUserWord({ userWordId: "u9", input: "新", translation: "new" }));

    await act(async () => {
      await result.current.addCustomWord({ input: "新", translation: "new", sourceLang: "JA", targetLang: "EN" });
    });

    expect(result.current.words[0]?.userWordId).toBe("u9");
    expect(result.current.words).toHaveLength(3);
    expect(mockGetAll).toHaveBeenCalledTimes(callsAfterLoad);
  });

  it("untag removes the row from a sub-list view", async () => {
    // offset-aware so the stream terminates (page 0 full → page 2 empty → stop).
    mockGetInList.mockImplementation(({ offset = 0 }) =>
      Promise.resolve(offset === 0 ? [uw1, uw2] : []),
    );
    const { result } = renderHook(() => useLists("user-1"));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => result.current.setSelectedListId("list-A"));
    await waitFor(() => expect(result.current.words).toHaveLength(2));
    const callsInList = mockGetInList.mock.calls.length;
    mockUntag.mockResolvedValue(undefined);

    await act(async () => {
      await result.current.untagWord("u1");
    });

    expect(result.current.words.map((w) => w.userWordId)).toEqual(["u2"]);
    expect(mockGetInList).toHaveBeenCalledTimes(callsInList); // no reload
  });
});

describe("useLists — stream/mutation race guard (suppressedIds)", () => {
  it("a word deleted while a later batch is still streaming is not resurrected", async () => {
    // Control the SECOND page so we can delete u3 while offset-2 is in flight.
    let resolvePage2!: (rows: ReturnType<typeof makeUserWord>[]) => void;
    const page2 = new Promise<ReturnType<typeof makeUserWord>[]>((r) => (resolvePage2 = r));
    mockGetAll.mockImplementation(({ offset = 0 }) =>
      offset === 0 ? Promise.resolve([uw1, uw2]) : page2,
    );
    mockDelete.mockResolvedValue(undefined);

    const { result } = renderHook(() => useLists("user-1"));
    // First page landed; the stream is now awaiting page 2.
    await waitFor(() => expect(result.current.words).toHaveLength(2));
    expect(result.current.fullyLoaded).toBe(false);

    // Delete u3 BEFORE its page arrives → it goes into suppressedIds.
    await act(async () => {
      await result.current.deleteWord("u3");
    });

    // Now the streaming page 2 (which contains u3) resolves.
    await act(async () => {
      resolvePage2([uw3]);
      await page2;
    });

    await waitFor(() => expect(result.current.fullyLoaded).toBe(true));
    // u3 must NOT be resurrected by the late page.
    expect(result.current.words.map((w) => w.userWordId)).toEqual(["u1", "u2"]);
  });
});
