// @vitest-environment jsdom
// The Filter button sits in a row with Add word / Select / Summary, and takes the same
// solid fill they do while its panel is open.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { LocaleProvider } from "@/i18n";
import { FilterButton } from "@/components/lists/FilterMenu";
import { NO_FILTERS } from "@/services/words/filters";

afterEach(cleanup);

const button = (open: boolean, filters = NO_FILTERS) => {
  render(
    <LocaleProvider>
      <FilterButton filters={filters} open={open} onToggle={vi.fn()} />
    </LocaleProvider>,
  );
  return screen.getByRole("button");
};

describe("FilterButton", () => {
  it("closed with no filters is a plain button", () => {
    const b = button(false);
    expect(b.className).not.toContain("btn--primary");
    expect(b.className).not.toContain("filtermenu__btn--on");
  });

  it("open takes the solid fill its neighbours take", () => {
    expect(button(true).className).toContain("btn--primary");
  });

  it("closed with filters applied keeps the outline and the count", () => {
    const b = button(false, { ...NO_FILTERS, pos: ["noun"] });
    expect(b.className).toContain("filtermenu__btn--on");
    expect(b.className).not.toContain("btn--primary");
    expect(b.querySelector(".filtermenu__badge")?.textContent).toBe("1");
  });
});
