// @vitest-environment jsdom
// The added / last-reviewed axes: a DROPDOWN of named spans per axis, and a calendar
// only for "custom".
//
// What's pinned:
//   * a named span applies in one pick, and no calendar appears for it;
//   * "custom" opens the calendar, which has its own ✕;
//   * the selection GRAMMAR inside it — one click is a single day, the second opens it
//     into a span (either way round), a third starts over;
//   * each day prints how many words fall on it, counted against the OTHER filters;
//   * only one calendar is open at a time (the panel is in the page flow).
//
// The DAY MATHS (local boundaries, half-open spans, a reversed range) is the model's,
// and is tested in tests/services/words/filters.test.ts.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { FilterPanel } from "@/components/lists/FilterMenu";
import { NO_FILTERS, dayKey, type FilterTarget, type WordFilters } from "@/services/words/filters";
import { LocaleProvider } from "@/i18n";

// A fixed "now" — the calendar opens on the current month and refuses future days, so
// the grid the assertions walk has to be the same one every run. Mid-month, so both
// arrows have somewhere to go.
const NOW = new Date(2026, 2, 18, 12, 0, 0); // Wed 18 March 2026

const onChange = vi.fn();

type Word = FilterTarget;
const word = (added: string, over: Partial<Word> = {}): Word => ({
  sourceLang: "JA",
  proficiencyBand: null,
  partOfSpeech: null,
  frequency: null,
  confidenceRating: 0,
  originallyTranslatedDate: added,
  lastReviewedDate: null,
  ...over,
});

function panel(filters: WordFilters = NO_FILTERS, historyWords: Word[] = []) {
  return render(
    <LocaleProvider>
      <FilterPanel
        filters={filters}
        onChange={onChange}
        onClose={() => {}}
        langsPresent={[]}
        posPresent={[]}
        historyWords={historyWords}
      />
    </LocaleProvider>,
  );
}

/** The day button for a March 2026 date, by its accessible (full-date) name. */
const march = (d: number) =>
  screen.getByRole("button", { name: new RegExp(`March ${d}, 2026( — .*)?$`) });

const addedSelect = () => screen.getByRole("combobox", { name: /Filter by date added/ }) as HTMLSelectElement;
const reviewedSelect = () =>
  screen.getByRole("combobox", { name: /Filter by date last reviewed/ }) as HTMLSelectElement;
const choose = (select: HTMLSelectElement, value: string) =>
  fireEvent.change(select, { target: { value } });
const calendarOpen = () => screen.queryByText("March 2026") !== null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  onChange.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("the date axes — dropdown + custom calendar", () => {
  it("rests on 'all time' with no calendar", () => {
    panel();
    expect(addedSelect().value).toBe("all");
    expect(calendarOpen()).toBe(false);
  });

  it("applies a named span in one pick, ending TODAY, without opening a calendar", () => {
    panel();
    choose(addedSelect(), "week");
    expect(onChange).toHaveBeenLastCalledWith(
      // Mon 16 March 2026 → today.
      expect.objectContaining({ added: { from: "2026-03-16", to: dayKey(NOW) } }),
    );
    expect(calendarOpen()).toBe(false);
  });

  it("reads a stored named span back as that option", () => {
    panel({ ...NO_FILTERS, added: { from: "2026-03-16", to: "2026-03-18" } });
    expect(addedSelect().value).toBe("week");
  });

  it("opens the calendar only for 'custom', and its ✕ closes it", () => {
    panel();
    choose(addedSelect(), "custom");
    expect(calendarOpen()).toBe(true);
    expect(addedSelect().value).toBe("custom"); // stays on custom before any day is picked

    fireEvent.click(screen.getByRole("button", { name: "Close calendar" }));
    expect(calendarOpen()).toBe(false);
  });

  it("takes one click as a single day and the second as the span", () => {
    panel();
    choose(addedSelect(), "custom");

    fireEvent.click(march(3));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ added: { from: "2026-03-03", to: "2026-03-03" } }),
    );

    fireEvent.click(march(9));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ added: { from: "2026-03-03", to: "2026-03-09" } }),
    );
  });

  it("sorts the two clicks, so the end may be picked first", () => {
    panel();
    choose(addedSelect(), "custom");
    fireEvent.click(march(9));
    fireEvent.click(march(3));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ added: { from: "2026-03-03", to: "2026-03-09" } }),
    );
  });

  it("starts a NEW span on the third click instead of growing the old one", () => {
    panel();
    choose(addedSelect(), "custom");
    fireEvent.click(march(3));
    fireEvent.click(march(9));
    fireEvent.click(march(12));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ added: { from: "2026-03-12", to: "2026-03-12" } }),
    );
  });

  it("refuses days in the future — nothing was added or reviewed tomorrow", () => {
    panel();
    choose(addedSelect(), "custom");
    expect((march(19) as HTMLButtonElement).disabled).toBe(true);
    expect((march(18) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Next month" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("prints how many words were added on each day", () => {
    const words = [
      ...Array.from({ length: 24 }, () => word(new Date(2026, 2, 3, 10).toISOString())),
      word(new Date(2026, 2, 9, 21).toISOString()),
    ];
    panel(NO_FILTERS, words);
    choose(addedSelect(), "custom");

    expect(march(3).querySelector(".cal__count")?.textContent).toBe("24");
    expect(march(3).getAttribute("aria-label")).toMatch(/— 24 words$/);
    expect(march(9).querySelector(".cal__count")?.textContent).toBe("1");
    expect(march(4).querySelector(".cal__count")?.textContent).toBe("");
  });

  it("counts against the OTHER filters, not the axis itself", () => {
    const words = [
      word(new Date(2026, 2, 3, 10).toISOString(), { confidenceRating: 5 }),
      word(new Date(2026, 2, 3, 11).toISOString(), { confidenceRating: 1 }),
      word(new Date(2026, 2, 5, 11).toISOString(), { confidenceRating: 5 }),
    ];
    // Confidence narrowed to 4–5, and an added span that excludes the 5th.
    panel(
      { ...NO_FILTERS, confA: 4, confB: 5, added: { from: "2026-03-03", to: "2026-03-03" } },
      words,
    );
    fireEvent.click(screen.getByRole("button", { name: /edit custom range/ }));
    expect(march(3).querySelector(".cal__count")?.textContent).toBe("1"); // the confidence-1 word is out
    expect(march(5).querySelector(".cal__count")?.textContent).toBe("1"); // outside the span, still counted
  });

  it("counts reviews on the reviewed axis, skipping never-reviewed words", () => {
    const words = [
      word(new Date(2026, 1, 1).toISOString(), { lastReviewedDate: new Date(2026, 2, 10, 9).toISOString() }),
      word(new Date(2026, 1, 1).toISOString()),
    ];
    panel(NO_FILTERS, words);
    choose(reviewedSelect(), "custom");
    expect(march(10).querySelector(".cal__count")?.textContent).toBe("1");
  });

  it("reads a custom span back on its button, and the button re-opens the calendar", () => {
    panel({ ...NO_FILTERS, added: { from: "2026-03-03", to: "2026-03-09" } });
    expect(addedSelect().value).toBe("custom");
    const edit = screen.getByRole("button", { name: /Added: edit custom range/ });
    expect(edit.textContent).toContain("Mar 3 – Mar 9");
    fireEvent.click(edit);
    expect(calendarOpen()).toBe(true);
  });

  it("opens ON the selected span, not on today's month", () => {
    panel({ ...NO_FILTERS, reviewed: { from: "2025-11-02", to: "2025-11-08" } });
    fireEvent.click(screen.getByRole("button", { name: /Reviewed: edit custom range/ }));
    expect(screen.getByText("November 2025")).toBeTruthy();
  });

  it("shows only one calendar at a time", () => {
    panel();
    choose(addedSelect(), "custom");
    expect(screen.getAllByText(/March 2026/).length).toBe(1);

    choose(reviewedSelect(), "custom");
    expect(screen.getAllByText(/March 2026/).length).toBe(1);
    expect(screen.getByRole("group", { name: /Reviewed: pick a date range/ })).toBeTruthy();
  });

  it("picking a named span closes an open custom calendar", () => {
    panel();
    choose(addedSelect(), "custom");
    choose(addedSelect(), "month");
    expect(calendarOpen()).toBe(false);
  });
});
