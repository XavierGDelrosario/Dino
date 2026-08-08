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

/**
 * Pretend the browser wrapped the options `perRow` to a line, `pageOffset` px down the
 * page. That offset is the whole point: an earlier version measured with `offsetTop`,
 * which is relative to the nearest POSITIONED ancestor — the page, not the container —
 * so it grouped the rows correctly (right button count) but set a fold hundreds of px
 * down, and `max-height: <that>` clipped nothing. The button appeared and every option
 * stayed visible. Any measurement here must be relative to the CONTAINER, so the tests
 * put the container well down the page and assert the clamp is still two rows tall.
 */
function stubWrap(perRow: number, pageOffset = 600) {
  const rect = (top: number, height: number) =>
    ({ top, bottom: top + height, height, left: 0, right: 0, width: 0, x: 0, y: top,
       toJSON: () => {} }) as DOMRect;

  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    const parent = this.parentElement;
    if (this.className.includes("filtermenu__checks")) return rect(pageOffset, 0);
    if (parent?.className.includes("filtermenu__checks")) {
      const i = Array.from(parent.children).indexOf(this);
      return rect(pageOffset + Math.floor(i / perRow) * ROW_HEIGHT, ROW_HEIGHT);
    }
    return rect(0, 0);
  };
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

    // Clipped at the bottom of row 2 — a MEASURED height, relative to the CONTAINER.
    // The container sits 600px down the page in this stub; the clamp must still be two
    // rows tall (60px), not 660px, or it clips nothing at all (the bug this pins).
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
