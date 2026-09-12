// @vitest-environment jsdom
// The appearance control after it left the profile menu: ONE top-bar button that
// cycles System → Light → Dark → System.
//
// What matters is that the cycle is complete and reachable — with no visible list of
// options, a cycle that skipped a mode or dead-ended would leave that mode with no way
// in at all — and that each click still repaints (stamps <html data-theme>) and
// persists, with "System" handing control back to the OS rather than storing a colour.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { LocaleProvider } from "@/i18n";
import { ThemeToggle } from "@/components/common/ThemeToggle";

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  // OS is dark, so a light stamp can only have come from a click.
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    media: "(prefers-color-scheme: light)",
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => true,
    onchange: null,
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const draw = () =>
  render(
    <LocaleProvider>
      <ThemeToggle />
    </LocaleProvider>,
  );

/** The one control — found by role, so a second button here would fail the test. */
const toggle = () => screen.getByRole("button");

describe("ThemeToggle", () => {
  it("is a single button naming the current mode and the next one", () => {
    draw();
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(toggle().getAttribute("aria-label")).toBe("Appearance: System — switch to Light");
  });

  it("cycles System → Light → Dark → System, painting and persisting each", () => {
    draw();

    fireEvent.click(toggle());
    expect(localStorage.getItem("dino.theme")).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(toggle().getAttribute("aria-label")).toBe("Appearance: Light — switch to Dark");

    fireEvent.click(toggle());
    expect(localStorage.getItem("dino.theme")).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");

    fireEvent.click(toggle());
    expect(localStorage.getItem("dino.theme")).toBe("system");
    // OS is dark (stubbed above), so "system" must resolve back to dark…
    expect(document.documentElement.dataset.theme).toBe("dark");
    // …and the cycle is back where it started, so every mode stays reachable.
    expect(toggle().getAttribute("aria-label")).toBe("Appearance: System — switch to Light");
  });
});
