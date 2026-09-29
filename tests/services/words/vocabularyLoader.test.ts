// The vocabulary loader: a cold load paints from a small first page then bulk pages;
// concurrent callers share one load; a fresh cache costs nothing; a STALE one is
// re-checked off to the side and swapped in, and a failed re-check keeps the cache.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeUserWord } from "@test/fixtures";

vi.mock("@/services/lists", () => ({ listUserLists: vi.fn() }));
vi.mock("@/services/words/userWords", () => ({
  USER_WORDS_PAGE_SIZE: 2,
  USER_WORDS_BULK_PAGE_SIZE: 3,
  getAllUserWords: vi.fn(),
  getListMembership: vi.fn(),
}));

import { ensureVocabulary } from "@/services/words/vocabularyLoader";
import * as vocab from "@/services/words/vocabularyCache";
import { listUserLists } from "@/services/lists";
import { getAllUserWords, getListMembership } from "@/services/words/userWords";

const mockAll = vi.mocked(getAllUserWords);
const mockLists = vi.mocked(listUserLists);
const mockMembership = vi.mocked(getListMembership);
const U = "user-1";
const w = (id: string) => makeUserWord({ userWordId: id });

beforeEach(() => {
  vi.clearAllMocks();
  vocab.resetVocabulary();
  mockLists.mockResolvedValue([]);
  mockMembership.mockResolvedValue([]);
});
afterEach(() => vi.useRealTimers());

describe("ensureVocabulary", () => {
  it("cold: a small first page, then bulk pages until one comes back short", async () => {
    const pages: Record<number, ReturnType<typeof w>[]> = { 0: [w("a"), w("b")], 2: [w("c"), w("d"), w("e")], 5: [w("f")] };
    mockAll.mockImplementation(async ({ offset = 0 }) => pages[offset] ?? []);

    await ensureVocabulary(U);

    expect(mockAll.mock.calls.map(([p]) => [p.offset, p.limit])).toEqual([[0, 2], [2, 3], [5, 3]]);
    expect(vocab.wordsFor(U, null)).toHaveLength(6);
    expect(vocab.isFresh(U)).toBe(true);
  });

  it("shares one in-flight load, and a fresh cache makes no request", async () => {
    mockAll.mockResolvedValue([w("a")]);
    const [x, y] = [ensureVocabulary(U), ensureVocabulary(U)];
    expect(x).toBe(y);
    await x;
    await ensureVocabulary(U);
    expect(mockAll).toHaveBeenCalledTimes(1);
  });

  it("stale: keeps showing the cache, then swaps in the re-checked snapshot", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    mockAll.mockResolvedValue([w("a")]);
    await ensureVocabulary(U);

    vi.setSystemTime(Date.now() + vocab.VOCABULARY_TTL_MS + 1);
    expect(vocab.isFresh(U)).toBe(false);
    mockAll.mockResolvedValue([w("b"), ]); // changed on another device
    const recheck = ensureVocabulary(U);
    expect(vocab.wordsFor(U, null).map((x) => x.userWordId)).toEqual(["a"]); // still readable meanwhile
    await recheck;
    expect(vocab.wordsFor(U, null).map((x) => x.userWordId)).toEqual(["b"]);
  });

  it("a failed re-check keeps the cached copy and does not reject", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    mockAll.mockResolvedValue([w("a")]);
    await ensureVocabulary(U);
    vi.setSystemTime(Date.now() + vocab.VOCABULARY_TTL_MS + 1);
    mockAll.mockRejectedValue(new Error("offline"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(ensureVocabulary(U)).resolves.toBeUndefined();
    expect(vocab.wordsFor(U, null).map((x) => x.userWordId)).toEqual(["a"]);
    warn.mockRestore();
  });

  it("a failed cold load rejects, and the next call starts over", async () => {
    mockAll.mockRejectedValueOnce(new Error("boom"));
    await expect(ensureVocabulary(U)).rejects.toThrow("boom");
    mockAll.mockResolvedValue([w("a")]);
    await ensureVocabulary(U);
    expect(vocab.wordsFor(U, null)).toHaveLength(1);
  });
});
