// @vitest-environment jsdom
// The top-bar menus (profile, app language) close on a tap anywhere else, and on Escape.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { PopoverMenu } from "@/components/common/PopoverMenu";

afterEach(cleanup);

const menu = (open: boolean, onClose = vi.fn(), onToggle = vi.fn()) => {
  render(
    <div>
      <PopoverMenu icon="👤" ariaLabel="Profile" open={open} onToggle={onToggle} onClose={onClose}>
        <button>Sign out</button>
      </PopoverMenu>
      <p>elsewhere</p>
    </div>,
  );
  return { onClose, onToggle };
};

describe("PopoverMenu", () => {
  it("closes on a press anywhere outside it", () => {
    const { onClose } = menu(true);
    fireEvent.pointerDown(screen.getByText("elsewhere"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape", () => {
    const { onClose } = menu(true);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("a press INSIDE it — an item, or its own button — does not count as outside", () => {
    const { onClose } = menu(true);
    fireEvent.pointerDown(screen.getByText("Sign out"));
    fireEvent.pointerDown(screen.getByRole("button", { name: "Profile" }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("listens only while open", () => {
    const { onClose } = menu(false);
    fireEvent.pointerDown(screen.getByText("elsewhere"));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });
});
