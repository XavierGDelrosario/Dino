// @vitest-environment jsdom
// The multi-select toolbar shows ONE of "Select all" / "Unselect all" — never both —
// and offers the destructive action only once something is picked.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { LocaleProvider } from "@/i18n";
import { SelectionBar } from "@/components/lists/SelectionBar";

function renderBar(over: Partial<Parameters<typeof SelectionBar>[0]> = {}) {
  const props = {
    count: 0,
    visibleCount: 10,
    lists: [],
    onSelectAll: vi.fn(),
    onUnselectAll: vi.fn(),
    onAddToList: vi.fn(),
    onCreateList: vi.fn(async () => {}),
    remove: { label: "Delete", title: "Delete 0 selected", danger: true, onClick: vi.fn() },
    ...over,
  };
  render(
    <LocaleProvider>
      <SelectionBar {...props} />
    </LocaleProvider>,
  );
  return props;
}

const selectAll = () => screen.queryByRole("button", { name: "Select all" });
const unselectAll = () => screen.queryByRole("button", { name: "Unselect all" });

afterEach(cleanup);

describe("SelectionBar — select all / unselect all", () => {
  it("nothing picked: Select all only", () => {
    const p = renderBar();
    expect(unselectAll()).toBeNull();
    fireEvent.click(selectAll()!);
    expect(p.onSelectAll).toHaveBeenCalledOnce();
  });

  it("one picked — even with more still showing: Unselect all only", () => {
    const p = renderBar({ count: 1 });
    expect(selectAll()).toBeNull();
    fireEvent.click(unselectAll()!);
    expect(p.onUnselectAll).toHaveBeenCalledOnce();
  });

  it("nothing shown and nothing picked: a disabled Select all", () => {
    renderBar({ visibleCount: 0 });
    expect(selectAll()).toHaveProperty("disabled", true);
    expect(unselectAll()).toBeNull();
  });
});

describe("SelectionBar — delete / remove", () => {
  it("is absent until something is picked", () => {
    renderBar();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });

  it("runs the view's action on the picks", () => {
    const p = renderBar({ count: 2 });
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(p.remove.onClick).toHaveBeenCalledOnce();
  });
});
