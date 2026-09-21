// @vitest-environment jsdom
// Opening "＋ New list" must not move the chip row out from under the user.
//
// The row scrolls sideways, and `autoFocus` hands the scrolling of it to the browser,
// which brings a focused element into view by CENTRING it in its scroll container —
// so the name field landed mid-row with the lists pushed off both edges. What's
// pinned here is the two halves of the replacement: focus that does not scroll, and a
// scroll position we choose ourselves.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { LocaleProvider } from "@/i18n";
import { ListChips } from "@/components/lists/ListChips";
import type { List } from "@/services/lists";

const LISTS: List[] = [
  { listId: "l-1", listName: "Verbs" } as List,
  { listId: "l-2", listName: "N3" } as List,
];

function renderChips() {
  return render(
    <LocaleProvider>
      <ListChips
        lists={LISTS}
        selectedListId={null}
        onSelect={() => {}}
        onCreate={() => {}}
        onDelete={() => {}}
      />
    </LocaleProvider>,
  );
}

const openCreate = () => fireEvent.click(screen.getByRole("button", { name: /new list/i }));
const nameField = () => screen.getByRole("textbox");

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ListChips — opening the new-list name field", () => {
  it("focuses the field without letting the browser scroll to it", () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    renderChips();
    openCreate();
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(document.activeElement).toBe(nameField());
  });

  it("does not use autoFocus, which is what handed the scroll to the browser", () => {
    renderChips();
    openCreate();
    // React renders `autoFocus` as the `autofocus` attribute; its presence would mean
    // the browser scrolls the row on its own terms again, whatever we do afterwards.
    expect(nameField().hasAttribute("autofocus")).toBe(false);
  });

  it("puts the row at its end, where the ＋ New list chip was", () => {
    const { container } = renderChips();
    const row = container.querySelector(".chips") as HTMLElement;
    // jsdom lays nothing out, so scrollWidth is 0 — stand in for an overflowing row.
    Object.defineProperty(row, "scrollWidth", { value: 640, configurable: true });
    openCreate();
    expect(row.scrollLeft).toBe(640); // a real browser clamps this to the max scroll
  });
});
