// @vitest-environment jsdom
// The picker in the account menu. Three values, one setting: the current one is
// marked, clicking another repaints (stamps <html data-theme>) and persists, and
// "System" hands control back to the OS rather than storing a colour.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { LocaleProvider } from "@/i18n";
import { ThemePicker } from "@/components/common/ThemePicker";

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  // OS is dark, so a light stamp can only have come from the click.
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
      <ThemePicker />
    </LocaleProvider>
  );

describe("ThemePicker", () => {
  it("offers exactly System / Light / Dark, with the current one checked", () => {
    draw();
    const options = screen.getAllByRole("radio");
    expect(options).toHaveLength(3);
    expect(options.map((o) => o.textContent?.replace(/[^\w]/g, ""))).toEqual([
      "System",
      "Light",
      "Dark",
    ]);
    expect(screen.getByRole("radio", { name: /system/i }).getAttribute("aria-checked")).toBe("true");
  });

  it("paints and persists the chosen theme", () => {
    draw();
    fireEvent.click(screen.getByRole("radio", { name: /light/i }));

    expect(document.documentElement.dataset.theme).toBe("light");
    expect(localStorage.getItem("dino.theme")).toBe("light");
    expect(screen.getByRole("radio", { name: /light/i }).getAttribute("aria-checked")).toBe("true");
  });

  it("goes back to following the OS on System", () => {
    draw();
    fireEvent.click(screen.getByRole("radio", { name: /light/i }));
    fireEvent.click(screen.getByRole("radio", { name: /system/i }));

    expect(localStorage.getItem("dino.theme")).toBe("system");
    // OS is dark (stubbed above), so "system" must resolve back to dark.
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});
