// @vitest-environment jsdom
// The added / last-reviewed axes after they became day SPANS picked on a calendar.
//
// What's pinned is the selection GRAMMAR — the part a five-option <select> never had
// and the part a user notices when it's wrong:
//   * one click is a single day, the second click opens it into a span (either way
//     round, so you can pick the end first);
//   * a third click starts over rather than extending forever;
//   * the presets still answer "this week" in one click, and "all time" clears;
//   * only one calendar is open at a time (the panel is in the page flow — two
//     7-column grids would push the rows they filter off the screen).
//
// The DAY MATHS (local boundaries, half-open spans, a reversed range) is the model's,
// and is tested in tests/services/words/filters.test.ts.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { FilterPanel } from "@/components/lists/FilterMenu";
import { NO_FILTERS, dayKey, type WordFilters } from "@/services/words/filters";
import { LocaleProvider } from "@/i18n";

// A fixed "now" — the calendar opens on the current month and refuses future days, so
// the grid the assertions walk has to be the same one every run. Mid-month, so both
// arrows have somewhere to go.
const NOW = new Date(2026, 2, 18, 12, 0, 0); // Wed 18 March 2026

const onChange = vi.fn();

function panel(filters: WordFilters = NO_FILTERS) {
  return render(
    <LocaleProvider>
      <FilterPanel
        filters={filters}
        onChange={onChange}
        onClose={() => {}}
        langsPresent={[]}
        posPresent={[]}
      />
    </LocaleProvider>,
  );
}

/** The day button for a March 2026 date, by its accessible (full-date) name. */
const march = (d: number) => screen.getByRole("button", { name: new RegExp(`March ${d}, 2026$`) });

const trigger = (name: RegExp) => screen.getByRole("button", { name });
const added = () => trigger(/Filter by date added/);
const reviewed = () => trigger(/Filter by date last reviewed/);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  onChange.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("the date axes — calendar range", () => {
  it("shows 'all time' at rest and opens the calendar on the current month", () => {
    panel();
    expect(added().textContent).toContain("all time");
    // Closed until asked for: the panel has six axes and a calendar is the tallest.
    expect(screen.queryByText("March 2026")).toBeNull();

    fireEvent.click(added());
    expect(screen.getByText("March 2026")).toBeTruthy();
  });

  it("takes one click as a single day and the second as the span", () => {
    panel();
    fireEvent.click(added());

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
    fireEvent.click(added());
    fireEvent.click(march(9));
    fireEvent.click(march(3));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ added: { from: "2026-03-03", to: "2026-03-09" } }),
    );
  });

  it("starts a NEW span on the third click instead of growing the old one", () => {
    // Without this a range can only ever widen, and the only way back is Clear all.
    panel();
    fireEvent.click(added());
    fireEvent.click(march(3));
    fireEvent.click(march(9));
    fireEvent.click(march(12));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ added: { from: "2026-03-12", to: "2026-03-12" } }),
    );
  });

  it("refuses days in the future — nothing was added or reviewed tomorrow", () => {
    panel();
    fireEvent.click(added());
    expect((march(19) as HTMLButtonElement).disabled).toBe(true);
    expect((march(18) as HTMLButtonElement).disabled).toBe(false);
    // …and the month arrow stops at the current month for the same reason.
    expect((screen.getByRole("button", { name: "Next month" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("keeps the old <select>'s periods as one-click presets, ending TODAY", () => {
    panel();
    fireEvent.click(added());
    fireEvent.click(screen.getByRole("button", { name: "this week" }));
    expect(onChange).toHaveBeenLastCalledWith(
      // Mon 16 March 2026 → today. The span ENDS today; the old cutoff had no end.
      expect.objectContaining({ added: { from: "2026-03-16", to: dayKey(NOW) } }),
    );

    fireEvent.click(screen.getByRole("button", { name: "all time" }));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ added: { from: null, to: null } }),
    );
  });

  it("reads the span back on the closed trigger", () => {
    panel({ ...NO_FILTERS, added: { from: "2026-03-03", to: "2026-03-09" } });
    expect(added().textContent).toContain("Mar 3 – Mar 9");
  });

  it("opens ON the selected span, not on today's month", () => {
    panel({ ...NO_FILTERS, reviewed: { from: "2025-11-02", to: "2025-11-08" } });
    fireEvent.click(reviewed());
    expect(screen.getByText("November 2025")).toBeTruthy();
  });

  it("shows only one calendar at a time", () => {
    panel();
    fireEvent.click(added());
    expect(screen.getAllByText(/March 2026/).length).toBe(1);

    fireEvent.click(reviewed());
    expect(screen.getAllByText(/March 2026/).length).toBe(1);
    expect(added().getAttribute("aria-expanded")).toBe("false");
    expect(reviewed().getAttribute("aria-expanded")).toBe("true");
  });
});
