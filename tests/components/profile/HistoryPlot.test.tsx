// @vitest-environment jsdom
// The confidence plot's two interactive layers: the line toggles beside it (hide/show a
// level) and the zoom controls (Reset only means something once zoomed). The window
// arithmetic itself is pinned in plotView.test.ts.
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { LocaleProvider } from "@/i18n";
import { HistoryPlot } from "@/components/profile/HistoryPlot";
import type { ProfileHistory } from "@/services/history";

afterEach(cleanup);

const day = (offset: number) => {
  const d = new Date();
  d.setDate(d.getDate() - offset);
  return d.toISOString().slice(0, 10);
};

const history: ProfileHistory = {
  mainLang: "JA",
  days: [],
  bands: [],
  confidence: [5, 3, 1].map((o, i) => ({
    day: day(o),
    wordCount: 10,
    avgConf: 2 + i * 0.3,
    mainLang: "JA",
    bandN: [0, 4, 6],
    bandConf: [null, 3 + i * 0.1, 1.5 + i * 0.2],
  })),
};

function renderConfidence() {
  const utils = render(
    <LocaleProvider>
      <HistoryPlot history={history} />
    </LocaleProvider>,
  );
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "confidence" } });
  return utils;
}

const lineCount = (c: HTMLElement) => c.querySelectorAll("polyline").length;

describe("HistoryPlot — confidence", () => {
  it("lists a toggle per line beside the plot, and a toggle hides/shows its line", () => {
    const { container } = renderConfidence();
    const toggles = within(screen.getByRole("list", { name: /lines to show/i })).getAllByRole("button");
    expect(toggles.length).toBeGreaterThanOrEqual(2);
    const before = lineCount(container);
    expect(before).toBe(toggles.length);

    fireEvent.click(toggles[0]);
    expect(toggles[0].getAttribute("aria-pressed")).toBe("false");
    expect(lineCount(container)).toBe(before - 1);

    fireEvent.click(toggles[0]);
    expect(lineCount(container)).toBe(before);
  });

  it("Reset and zoom-out are only live once zoomed in", () => {
    renderConfidence();
    const reset = screen.getByRole("button", { name: /reset/i }) as HTMLButtonElement;
    const out = screen.getByRole("button", { name: /zoom out/i }) as HTMLButtonElement;
    expect(reset.disabled).toBe(true);
    expect(out.disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: /zoom in/i }));
    expect(reset.disabled).toBe(false);
    expect(out.disabled).toBe(false);

    fireEvent.click(reset);
    expect(reset.disabled).toBe(true);
  });

  it("zooming in puts finer gridlines on the y axis", () => {
    const { container } = renderConfidence();
    const ticks = () => [...container.querySelectorAll(".hist-plot__tick")].map((t) => t.textContent);
    expect(ticks()).toContain("5");
    for (let i = 0; i < 3; i++) fireEvent.click(screen.getByRole("button", { name: /zoom in/i }));
    expect(ticks().some((t) => t?.includes("."))).toBe(true);
  });

  it("the activity plots have no toggles or zoom", () => {
    render(
      <LocaleProvider>
        <HistoryPlot history={history} />
      </LocaleProvider>,
    );
    expect(screen.queryByRole("list", { name: /lines to show/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /zoom in/i })).toBeNull();
  });
});
