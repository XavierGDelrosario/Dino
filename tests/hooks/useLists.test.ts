// @vitest-environment jsdom
// Hook spec for useLists — the Lists screen driver, reading the session VOCABULARY
// CACHE (services/words/vocabularyCache). ALL streams in once (first page, then bulk
// pages); every list is a FILTER over it via the membership map, so switching lists or
// remounting the tab costs no request; mutations reach the view through the services'
// write-through, never through a re-pull. The service boundary is mocked; the mocked
// writes call the REAL cache the way the real services do. Page sizes are mocked small
// (2) so multi-batch streaming is exercised with a few fixtures.
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
vi.mock("@/services/review", () => ({ softenConfidence: vi.fn() }));
vi.mock("@/services/words/userWords", () => ({
  USER_WORDS_PAGE_SIZE: 2, // small: a "full page" is 2, so 3 rows = 2 batches
  USER_WORDS_BULK_PAGE_SIZE: 2,
  getAllUserWords: vi.fn(),
  getListMembership: vi.fn(),
  saveDictionaryWord: vi.fn(),
  createCustomWord: vi.fn(),
  editUserWord: vi.fn(),
  deleteUserWord: vi.fn(),
  addUserWordsToList: vi.fn(),
  removeUserWordFromList: vi.fn(),
}));

import { useLists } from "@/hooks/useLists";
import { listUserLists } from "@/services/lists";
import {
  getAllUserWords,
  getListMembership,
  createCustomWord,
  editUserWord,
  deleteUserWord,
  removeUserWordFromList,
} from "@/services/words/userWords";
import * as vocab from "@/services/words/vocabularyCache";

const mockListLists = vi.mocked(listUserLists);
const mockGetAll = vi.mocked(getAllUserWords);
const mockMembership = vi.mocked(getListMembership);
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
  vocab.resetVocabulary();
  mockListLists.mockResolvedValue([{ listId: "list-A", listName: "A" }]);
  mockMembership.mockResolvedValue([{ listId: "list-A", userWordId: "u1" }, { listId: "list-A", userWordId: "u2" }]);
  // The real services write their result through to the cache; so do these.
  mockDelete.mockImplementation(async ({ userWordId }) => vocab.removeWord(userWordId));
  mockUntag.mockImplementation(async ({ listId, userWordId }) => vocab.retagInCache("untag", listId, [userWordId]));
});

async function loadedHook() {
  serveAllPages({ 0: [uw1, uw2], 2: [] }); // 2 rows loaded, fully
  const hook = renderHook(() => useLists("user-1"));
  await waitFor(() => expect(hook.result.current.fullyLoaded).toBe(true));
  return hook;
}

describe("useLists — loading", () => {
  it("streams every page into the cache and flips fullyLoaded when done", async () => {
    serveAllPages({ 0: [uw1, uw2], 2: [uw3] }); // page 0 full (2) → page 2 partial (1) → stop
    const { result } = renderHook(() => useLists("user-1"));

    await waitFor(() => expect(result.current.fullyLoaded).toBe(true));
    expect(result.current.status).toBe("ready");
    expect(result.current.words.map((w) => w.userWordId)).toEqual(["u1", "u2", "u3"]);
    expect(result.current.lists).toEqual([{ listId: "list-A", listName: "A" }]);
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

describe("useLists — no request to switch lists or come back", () => {
  it("a list is a filter over ALL: switching chips fetches nothing", async () => {
    serveAllPages({ 0: [uw1, uw2], 2: [uw3] });
    const { result } = renderHook(() => useLists("user-1"));
    await waitFor(() => expect(result.current.fullyLoaded).toBe(true));
    const calls = mockGetAll.mock.calls.length;

    act(() => result.current.setSelectedListId("list-A"));
    expect(result.current.status).toBe("ready");
    expect(result.current.words.map((w) => w.userWordId)).toEqual(["u1", "u2"]);

    act(() => result.current.setSelectedListId(null));
    expect(result.current.words).toHaveLength(3);
    expect(mockGetAll).toHaveBeenCalledTimes(calls);
  });

  it("remounting (leaving the tab and coming back) reuses the cache", async () => {
    const first = await loadedHook();
    first.unmount();
    const calls = mockGetAll.mock.calls.length;
    const membershipCalls = mockMembership.mock.calls.length;

    const { result } = renderHook(() => useLists("user-1"));
    expect(result.current.status).toBe("ready");
    expect(result.current.words).toHaveLength(2);
    expect(mockGetAll).toHaveBeenCalledTimes(calls);
    expect(mockMembership).toHaveBeenCalledTimes(membershipCalls);
  });

  it("a write from another tab (a review) shows up without a re-read", async () => {
    const { result } = await loadedHook();
    const calls = mockGetAll.mock.calls.length;

    act(() => vocab.writeWordById("u2", { stability: 30, lastReviewedDate: new Date().toISOString(),
      confidenceInputs: { stability: 30, lastReviewedDate: new Date().toISOString(), originallyTranslatedDate: null,
        shortStability: null, shortStabilityAt: null, peakConfidence: 0 } }));

    expect(result.current.words.find((w) => w.userWordId === "u2")!.confidenceRating).toBeGreaterThan(0);
    expect(mockGetAll).toHaveBeenCalledTimes(calls);
  });
});

describe("useLists — mutations reach the view through the cache (no re-pull)", () => {
  it("delete removes the row without re-fetching the list", async () => {
    const { result } = await loadedHook();
    const callsAfterLoad = mockGetAll.mock.calls.length;

    await act(async () => {
      await result.current.deleteWord("u1");
    });

    expect(result.current.words.map((w) => w.userWordId)).toEqual(["u2"]);
    expect(mockGetAll).toHaveBeenCalledTimes(callsAfterLoad);
  });

  it("edit replaces the row in place (keeps the new meaning)", async () => {
    const { result } = await loadedHook();
    const callsAfterLoad = mockGetAll.mock.calls.length;
    mockEdit.mockImplementation(async () => {
      const edited = makeUserWord({ userWordId: "u1", input: "一", translation: "ONE!" });
      vocab.writeWordById("u1", edited);
      return edited;
    });

    await act(async () => {
      await result.current.editWord("u1", "ONE!");
    });

    expect(result.current.words.find((w) => w.userWordId === "u1")?.translation).toBe("ONE!");
    expect(result.current.words).toHaveLength(2);
    expect(mockGetAll).toHaveBeenCalledTimes(callsAfterLoad);
  });

  it("addCustomWord prepends the new word — and files it into the open list", async () => {
    const { result } = await loadedHook();
    act(() => result.current.setSelectedListId("list-A"));
    const callsAfterLoad = mockGetAll.mock.calls.length;
    mockCreateCustom.mockImplementation(async ({ listId }) => {
      const created = makeUserWord({ userWordId: "u9", input: "新", translation: "new" });
      vocab.writeWords("user-1", [created], listId);
      return created;
    });

    await act(async () => {
      await result.current.addCustomWord({ input: "新", translation: "new", sourceLang: "JA", targetLang: "EN" });
    });

    expect(result.current.words[0]?.userWordId).toBe("u9");
    expect(result.current.words).toHaveLength(3);
    act(() => result.current.setSelectedListId(null));
    expect(result.current.words).toHaveLength(3);
    expect(mockGetAll).toHaveBeenCalledTimes(callsAfterLoad);
  });

  it("untag removes the row from a sub-list view, not from ALL", async () => {
    const { result } = await loadedHook();
    act(() => result.current.setSelectedListId("list-A"));

    await act(async () => {
      await result.current.untagWord("u1");
    });

    expect(result.current.words.map((w) => w.userWordId)).toEqual(["u2"]);
    act(() => result.current.setSelectedListId(null));
    expect(result.current.words).toHaveLength(2);
  });
});

describe("useLists — stream/mutation race guard", () => {
  it("a word deleted while a later batch is still streaming is not resurrected", async () => {
    // Control the SECOND page so we can delete u3 while offset-2 is in flight.
    let resolvePage2!: (rows: ReturnType<typeof makeUserWord>[]) => void;
    const page2 = new Promise<ReturnType<typeof makeUserWord>[]>((r) => (resolvePage2 = r));
    mockGetAll.mockImplementation(({ offset = 0 }) =>
      offset === 0 ? Promise.resolve([uw1, uw2]) : page2,
    );

    const { result } = renderHook(() => useLists("user-1"));
    // First page landed; the stream is now awaiting page 2.
    await waitFor(() => expect(result.current.words).toHaveLength(2));
    expect(result.current.fullyLoaded).toBe(false);

    await act(async () => {
      await result.current.deleteWord("u3");
    });

    await act(async () => {
      resolvePage2([uw3]);
      await page2;
    });

    await waitFor(() => expect(result.current.fullyLoaded).toBe(true));
    expect(result.current.words.map((w) => w.userWordId)).toEqual(["u1", "u2"]);
  });
});
