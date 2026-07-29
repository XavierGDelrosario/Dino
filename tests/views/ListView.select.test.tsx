// @vitest-environment jsdom
// The Lists multi-select: a Select toggle makes the rows pickable (no checkbox — the
// row itself is the control, exposed as a listbox option), the toolbar offers Select
// all / Unselect all, and "Add to list" tags the picked words.
//
// The contract worth pinning: a picked word SURVIVES A FILTER CHANGE and stays
// visible, PINNED to the top — filter → pick → re-filter → pick is how a user
// assembles a set out of several slices, and hiding the earlier picks would make the
// set impossible to see or undo. useLists is mocked; this is the view's selection
// logic, not the services.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, within, cleanup } from "@testing-library/react";
import { LocaleProvider } from "@/i18n";
import { makeUserWord } from "@test/fixtures";

const tagWords = vi.fn().mockResolvedValue(true);
const createListForWords = vi.fn().mockResolvedValue(true);

// Three words at distinct confidences, so the confidence filter can hide some.
const words = [
  makeUserWord({ userWordId: "uw-1", input: "猫", translation: "cat", confidenceRating: 0 }),
  makeUserWord({ userWordId: "uw-2", input: "犬", translation: "dog", confidenceRating: 3 }),
  makeUserWord({ userWordId: "uw-3", input: "鳥", translation: "bird", confidenceRating: 5 }),
];

vi.mock("@/hooks/useLists", () => ({
  useLists: () => ({
    lists: [{ listId: "l-1", listName: "Animals", userId: "u" }],
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
    tagWords,
    createListForWord: vi.fn(),
    createListForWords,
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

const rowFor = (word: string) =>
  screen.getByText(word).closest("li") as HTMLElement;

const isPicked = (word: string) => rowFor(word).getAttribute("aria-selected") === "true";

/** The words currently drawn, in render order (so pinning is observable). */
const renderedWords = () =>
  [...document.querySelectorAll(".listrow__head")].map((el) => el.firstChild?.textContent);

const enterSelectMode = () => fireEvent.click(screen.getByRole("button", { name: "Select" }));

/** Pick a destination inside the open add-to-list popover — scoped, because the
 *  same list name is also a chip at the top of the view. */
const pickListInMenu = (name: string) =>
  fireEvent.click(within(screen.getByRole("menu")).getByText(name));

/** Open the funnel and drag the confidence MIN thumb to `n` — hides every word below
 *  it. (The range axes live inside the filter popover, so it has to be opened first.) */
const filterConfidenceMin = (n: number) => {
  fireEvent.click(screen.getByRole("button", { name: "Filter words" }));
  fireEvent.change(screen.getByLabelText("Minimum confidence"), { target: { value: String(n) } });
};

beforeEach(() => {
  vi.clearAllMocks();
});

// The suite doesn't run with `globals: true`, so RTL's auto-cleanup never registers —
// unmount by hand or the previous test's rows linger and every query goes ambiguous.
afterEach(cleanup);

/** The pickable rows. Scoped to the word listbox — the sort <select>'s <option>s
 *  carry the same ARIA role and would otherwise be matched too. */
const pickableRows = () => within(screen.getByRole("listbox")).getAllByRole("option");

describe("ListView — multi-select", () => {
  it("rows are inert until Select is pressed — and there is NO checkbox UI", () => {
    view();
    expect(screen.queryByRole("listbox")).toBeNull(); // rows aren't options yet
    enterSelectMode();
    expect(pickableRows()).toHaveLength(3);
    expect(screen.queryByRole("checkbox")).toBeNull(); // the row IS the control
  });

  it("clicking the word row picks it", () => {
    view();
    enterSelectMode();
    fireEvent.click(screen.getByText("猫"));
    expect(isPicked("猫")).toBe(true);
    expect(screen.getByText("1 selected")).toBeTruthy();
  });

  it("Select all picks every word the filter shows; Unselect all clears them", () => {
    view();
    enterSelectMode();
    fireEvent.click(screen.getByRole("button", { name: "Select all" }));
    expect(screen.getByText("3 selected")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Unselect all" }));
    expect(screen.getByText("0 selected")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add to list" })).toBeNull();
  });

  it("a picked word STAYS VISIBLE through a filter that excludes it, pinned to the top", () => {
    view();
    enterSelectMode();

    // 猫 is the newest, so it already leads the default sort — pick it, then filter
    // it out (confidence 0 < 3). Being pinned is only meaningful if it survives.
    fireEvent.click(screen.getByText("猫"));
    filterConfidenceMin(3);

    expect(renderedWords()).toEqual(["猫", "犬", "鳥"]); // pinned first, then the matches
    expect(isPicked("猫")).toBe(true);
    expect(screen.getByText("1 selected")).toBeTruthy();

    // Un-picking it there removes it — the filter that excluded it now applies again.
    fireEvent.click(screen.getByText("猫"));
    expect(renderedWords()).toEqual(["犬", "鳥"]);
    expect(screen.getByText("0 selected")).toBeTruthy();
  });

  it("adds across both slices — the write carries picks the filter has excluded", () => {
    view();
    enterSelectMode();

    fireEvent.click(screen.getByText("猫")); // confidence 0
    filterConfidenceMin(3); // …now excluded by the filter, still pinned + picked
    fireEvent.click(screen.getByText("犬")); // a pick from the NEW slice
    expect(screen.getByText("2 selected")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Add to list" }));
    pickListInMenu("Animals");

    expect(tagWords).toHaveBeenCalledWith(["uw-1", "uw-2"], "l-1");
  });

  it("pinned picks don't duplicate a row that the filter already shows", () => {
    view();
    enterSelectMode();
    fireEvent.click(screen.getByText("犬")); // matches the filter AND is picked
    filterConfidenceMin(3);
    expect(renderedWords()).toEqual(["犬", "鳥"]); // pinned to the top, listed once
  });

  it("a successful add exits select mode (picks consumed)", async () => {
    view();
    enterSelectMode();
    fireEvent.click(screen.getByText("猫"));
    fireEvent.click(screen.getByRole("button", { name: "Add to list" }));
    pickListInMenu("Animals");

    await vi.waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    expect(screen.getByRole("button", { name: "Select" })).toBeTruthy();
  });

  it("a FAILED add keeps the selection (the user still has to react to the error)", async () => {
    tagWords.mockResolvedValueOnce(false);
    view();
    enterSelectMode();
    fireEvent.click(screen.getByText("猫"));
    fireEvent.click(screen.getByRole("button", { name: "Add to list" }));
    pickListInMenu("Animals");

    await vi.waitFor(() => expect(tagWords).toHaveBeenCalled());
    expect(screen.getByText("1 selected")).toBeTruthy();
    expect(isPicked("猫")).toBe(true);
  });

  it("leaving select mode drops the picks", () => {
    view();
    enterSelectMode();
    fireEvent.click(screen.getByText("猫"));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    enterSelectMode();
    expect(screen.getByText("0 selected")).toBeTruthy();
    expect(isPicked("猫")).toBe(false);
  });
});
