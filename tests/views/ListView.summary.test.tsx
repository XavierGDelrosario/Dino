// @vitest-environment jsdom
// The Lists "Summary" button (next to Review). The aggregation itself is unit-tested
// in tests/services/analyze/summarize.test.ts; what's pinned HERE is the wiring:
//   - the button toggles the panel open and closed;
//   - the panel describes the FILTERED set — the same words Review would quiz — so a
//     search narrows the summary too;
//   - there is NO coverage pie (every word in a list is already known).
// useLists is mocked — this is view wiring, not services.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { LocaleProvider } from "@/i18n";
import { makeUserWord } from "@test/fixtures";

const words = [
  makeUserWord({ userWordId: "uw-1", input: "猫", translation: "cat", inputReading: "ねこ", confidenceRating: 5 }),
  makeUserWord({ userWordId: "uw-2", input: "犬", translation: "dog", inputReading: "いぬ", confidenceRating: 2 }),
  makeUserWord({ userWordId: "uw-3", input: "飲む", translation: "to drink", inputReading: "のむ", confidenceRating: 2 }),
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

const summaryBtn = () => screen.getByRole("button", { name: /Summary/ });

afterEach(cleanup);

describe("ListView — summary", () => {
  it("toggles the panel from the button next to Review", () => {
    const { container } = view();
    const panel = () => container.querySelector(".lists__summary");
    expect(panel()).toBeNull();
    fireEvent.click(summaryBtn());
    expect(panel()).toBeTruthy();
    fireEvent.click(summaryBtn());
    expect(panel()).toBeNull();
  });

  it("renders ABOVE the add/select/filter row, under the button that opens it", () => {
    const { container } = view();
    fireEvent.click(summaryBtn());
    const panel = container.querySelector(".lists__summary")!;
    const toolbar = container.querySelector(".lists__toolbar")!;
    // DOCUMENT_POSITION_FOLLOWING (4) = the toolbar comes after the panel.
    expect(panel.compareDocumentPosition(toolbar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows NO coverage pie — a list is 100% known, so the split says nothing", () => {
    const { container } = view();
    fireEvent.click(summaryBtn());
    expect(container.querySelector(".agx-pie")).toBeNull();
    // The charts themselves are there.
    expect(screen.getByRole("tab", { name: "Confidence" })).toBeTruthy();
  });

  it("summarizes the FILTERED set — the same words Review would quiz", () => {
    const { container } = view();
    fireEvent.click(summaryBtn());
    // Three words, two of them at confidence 2 → the "2" bar counts 2.
    const barValue = (label: string) =>
      [...container.querySelectorAll(".agx-bar")]
        .find((el) => el.querySelector(".agx-bar__label")?.textContent === label)
        ?.querySelector(".agx-bar__val")?.textContent;
    expect(barValue("2")).toBe("2");

    // Narrow to 猫 (confidence 5) — the summary follows the filter.
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "ねこ" } });
    expect(barValue("2")).toBeUndefined(); // that bucket is empty now (bars with 0 are dropped)
    expect(barValue("5")).toBe("1");
  });
});
