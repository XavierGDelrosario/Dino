// @vitest-environment jsdom
// The Lists search bar (next to sort). The matching rules themselves are unit-tested in
// tests/services/words/search.test.ts; what's pinned HERE is the view's wiring:
//   - a kana query finds a kanji word by its READING (猫 via ねこ) — the reason the bar
//     exists at all, since you can't type 猫 without already having it;
//   - a query that matches nothing still leaves the search box on screen, so the query
//     that emptied the list can be edited or cleared (the box used to be gated on rows
//     being shown, which would have trapped the user);
//   - the clear button restores the full list.
// useLists is mocked — this is view wiring, not services.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { LocaleProvider } from "@/i18n";
import { makeUserWord } from "@test/fixtures";

const words = [
  makeUserWord({ userWordId: "uw-1", input: "猫", translation: "cat", inputReading: "ねこ" }),
  makeUserWord({ userWordId: "uw-2", input: "犬", translation: "dog", inputReading: "いぬ" }),
  makeUserWord({ userWordId: "uw-3", input: "飲む", translation: "to drink", inputReading: "のむ" }),
];

vi.mock("@/hooks/useLists", () => ({
  useLists: () => ({
    lists: [],
    selectedListId: null,
    setSelectedListId: vi.fn(),
    words,
    fullyLoaded: true,
    status: "ready",
    error: null,
    addCustomWord: vi.fn(),
    lookupDictionary: vi.fn(),
    saveSenseToList: vi.fn(),
    editWord: vi.fn(),
    deleteWord: vi.fn(),
    untagWord: vi.fn(),
    tagWord: vi.fn(),
    tagWords: vi.fn(),
    createListForWord: vi.fn(),
    createListForWords: vi.fn(),
    addList: vi.fn(),
    renameListById: vi.fn(),
    deleteListById: vi.fn(),
  }),
}));

import { ListView } from "@/views/ListView";

const view = () =>
  render(
    <LocaleProvider>
      <ListView userId="u" onReview={() => {}} />
    </LocaleProvider>,
  );

const searchBox = () => screen.getByRole("searchbox", { name: "Search words" }) as HTMLInputElement;
const search = (q: string) => fireEvent.change(searchBox(), { target: { value: q } });
const renderedWords = () =>
  [...document.querySelectorAll(".listrow__head")].map((el) => el.firstChild?.textContent);

afterEach(cleanup);

describe("ListView — search", () => {
  it("finds a kanji word by its kana READING (猫 via ねこ)", () => {
    view();
    expect(renderedWords()).toHaveLength(3);

    search("ねこ");

    expect(renderedWords()).toEqual(["猫"]);
  });

  it("finds words by headword and by meaning", () => {
    view();

    search("犬");
    expect(renderedWords()).toEqual(["犬"]);

    search("drink");
    expect(renderedWords()).toEqual(["飲む"]);
  });

  it("does not let a latin query hit readings ('no' must not match のむ)", () => {
    view();

    search("no");

    expect(renderedWords()).toEqual([]);
  });

  it("keeps the search box on screen when nothing matches, so the query can be cleared", () => {
    view();

    search("zzzz");
    expect(renderedWords()).toEqual([]);
    // The box (and its value) survive the empty result — otherwise the user is stuck.
    expect(searchBox().value).toBe("zzzz");

    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));

    expect(searchBox().value).toBe("");
    expect(renderedWords()).toHaveLength(3);
  });
});
