// @vitest-environment jsdom
// The "file into a list" popover must survive the swipe you make to scroll back to it,
// and opening "New list…" must not scroll the page.
//
// It used to close on ANY pointerdown outside it, so on a phone the scroll gesture
// itself dismissed the menu; and the name field used `autoFocus`, which on iOS scrolls
// the focused field into view — the list jumped the moment the field opened. Pinned
// here: a tap outside closes, a drag or a cancelled (browser-taken) gesture doesn't,
// and the field is focused with preventScroll.
import { describe, it, expect, afterEach, vi } from "vitest";
import { createRef } from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { LocaleProvider } from "@/i18n";
import { ListMenu } from "@/components/common/ListMenu";
import type { List } from "@/services/lists";

const LISTS: List[] = [{ listId: "l-1", listName: "Verbs" } as List];

// jsdom has no PointerEvent constructor; the handler only reads clientX/clientY.
function pointer(type: string, target: EventTarget, x: number, y: number) {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y }));
}

function renderMenu() {
  const onClose = vi.fn();
  const anchorRef = createRef<HTMLButtonElement>();
  render(
    <LocaleProvider>
      <button ref={anchorRef}>anchor</button>
      <p data-testid="outside">elsewhere</p>
      <ListMenu anchorRef={anchorRef} lists={LISTS} onPick={() => {}} onCreate={() => {}} onClose={onClose} />
    </LocaleProvider>,
  );
  return { onClose, outside: screen.getByTestId("outside") };
}

afterEach(cleanup);

describe("ListMenu — dismissal", () => {
  it("closes on a tap outside", () => {
    const { onClose, outside } = renderMenu();
    pointer("pointerdown", outside, 100, 100);
    pointer("pointerup", outside, 103, 102);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("stays open through a swipe (the gesture used to scroll back to it)", () => {
    const { onClose, outside } = renderMenu();
    pointer("pointerdown", outside, 100, 300);
    pointer("pointerup", outside, 100, 120);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("stays open when the browser takes the gesture over for scrolling (pointercancel)", () => {
    const { onClose, outside } = renderMenu();
    pointer("pointerdown", outside, 100, 100);
    pointer("pointercancel", outside, 100, 100);
    pointer("pointerup", outside, 100, 100);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("ignores taps inside the menu", () => {
    const { onClose } = renderMenu();
    const item = screen.getByRole("button", { name: "Verbs" });
    pointer("pointerdown", item, 10, 10);
    pointer("pointerup", item, 10, 10);
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("ListMenu — New list… field", () => {
  it("focuses without scrolling the page", () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    renderMenu();
    fireEvent.click(screen.getByRole("button", { name: /new list/i }));
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(document.activeElement?.tagName).toBe("INPUT");
    focus.mockRestore();
  });
});
