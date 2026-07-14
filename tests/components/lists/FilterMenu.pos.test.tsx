// @vitest-environment jsdom
// The part-of-speech axis collapses to two rows on a PHONE, behind a "Show N more".
//
// It's the one filter axis whose length is DATA-driven (one option per word class present
// in the vocabulary), and on a phone the panel is a single column — so it can run four or
// five rows and push every axis below it off-screen.
//
// LAYOUT IS STUBBED. jsdom has no layout engine: `offsetTop` is 0 for everything, so the
// real wrap can't happen here. The component groups options into rows by their laid-out
// `offsetTop`, so these tests feed it exactly that — a fake wrap — and assert the logic on
// top of it (which options fall below the fold, the clamp height, the toggle). The one
// thing this CANNOT prove is that the browser wraps where we think; that's what the CSS
// (`max-height: var(--pos-clamp); overflow: hidden`) and a real device are for.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { FilterPanel } from "@/components/lists/FilterMenu";
import { NO_FILTERS } from "@/services/words/filters";
import { LocaleProvider } from "@/i18n";
import type { PosCategory } from "@/services/language";

const ROW_HEIGHT = 30;

/** Pretend the browser wrapped the options `perRow` to a line. */
function stubWrap(perRow: number) {
  Object.defineProperty(HTMLElement.prototype, "offsetTop", {
    configurable: true,
    get(this: HTMLElement) {
      const parent = this.parentElement;
      if (!parent?.className.includes("filtermenu__checks")) return 0;
      const i = Array.from(parent.children).indexOf(this);
      return Math.floor(i / perRow) * ROW_HEIGHT;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get: () => ROW_HEIGHT,
  });
}

/** matchMedia is absent in jsdom — supply it, since the clamp is phone-only. */
function stubViewport(isPhone: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: isPhone,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

// Six word classes → 3 rows at 2 per row, so 2 options fall below the two-row fold.
const POS: PosCategory[] = ["noun", "verb", "adjective", "adverb", "particle", "counter"];

const renderPanel = (posPresent = POS) =>
  render(
    <LocaleProvider>
      <FilterPanel
        filters={NO_FILTERS}
        onChange={() => {}}
        onClose={() => {}}
        langsPresent={[]}
        posPresent={posPresent}
      />
    </LocaleProvider>,
  );

beforeEach(() => stubWrap(2));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("FilterPanel — part-of-speech, collapsed on a phone", () => {
  it("clamps to two rows and offers to reveal the rest", () => {
    stubViewport(true);
    renderPanel();

    // 3 rows of 2 → the third row (2 options) is below the fold.
    const more = screen.getByRole("button", { name: /show 2 more/i });
    expect(more).toBeTruthy();
    expect(more.getAttribute("aria-expanded")).toBe("false");

    // Clipped at the bottom of row 2 — a MEASURED height, not a guessed one.
    const checks = document.querySelector(".filtermenu__checks--clamped") as HTMLElement;
    expect(checks).toBeTruthy();
    expect(checks.style.getPropertyValue("--pos-clamp")).toBe(`${ROW_HEIGHT * 2}px`);

    // Every option stays in the DOM (clipped, not removed) — so the option a user is
    // hunting for is still findable by a screen reader / find-in-page. Scoped to the POS
    // container: the usage axis renders the same .filtermenu__check class.
    expect(checks.querySelectorAll(".filtermenu__check").length).toBe(POS.length);
  });

  it("shows everything once expanded, and can collapse again", () => {
    stubViewport(true);
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: /show 2 more/i }));
    const less = screen.getByRole("button", { name: /show less/i });
    expect(less.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector(".filtermenu__checks--clamped")).toBeNull(); // unclipped

    fireEvent.click(less);
    expect(screen.getByRole("button", { name: /show 2 more/i })).toBeTruthy();
    expect(document.querySelector(".filtermenu__checks--clamped")).toBeTruthy();
  });

  it("leaves the DESKTOP panel alone — no clamp, no button", () => {
    stubViewport(false);
    renderPanel();

    expect(screen.queryByRole("button", { name: /show \d+ more/i })).toBeNull();
    expect(document.querySelector(".filtermenu__checks--clamped")).toBeNull();
  });

  it("no button when the options already fit in two rows", () => {
    stubViewport(true);
    renderPanel(["noun", "verb", "adjective"]); // 2 per row → exactly 2 rows

    expect(screen.queryByRole("button", { name: /show \d+ more/i })).toBeNull();
    expect(document.querySelector(".filtermenu__checks--clamped")).toBeNull();
  });
});
