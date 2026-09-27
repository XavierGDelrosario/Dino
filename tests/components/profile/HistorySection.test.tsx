// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { LocaleProvider } from "@/i18n";
import { dayKey } from "@/services/words/filters";
import type { ProfileHistory } from "@/services/history";

const getProfileHistory = vi.fn<() => Promise<ProfileHistory | null>>();
vi.mock("@/services/history", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/history")>()),
  getProfileHistory: () => getProfileHistory(),
}));

import { HistorySection } from "@/components/profile/HistorySection";

const today = dayKey(new Date());
const history: ProfileHistory = {
  mainLang: "JA",
  days: [{ day: today, added: 7, reviewed: 3, reviews: 5 }],
  bands: [
    { band: 1, n: 10, avgConf: 3.2 },
    { band: -1, n: 4, avgConf: 1.1 },
  ],
  confidence: [],
};

const renderIt = () =>
  render(
    <LocaleProvider>
      <HistorySection userId="u1" />
    </LocaleProvider>,
  );

beforeEach(() => getProfileHistory.mockReset());
afterEach(cleanup);

describe("HistorySection", () => {
  it("renders nothing when the database has no profile_history()", async () => {
    getProfileHistory.mockResolvedValue(null);
    const { container } = renderIt();
    await waitFor(() => expect(getProfileHistory).toHaveBeenCalled());
    expect(container.querySelector(".hist")).toBeNull();
  });

  it("prints today's count on the calendar and switches metric", async () => {
    getProfileHistory.mockResolvedValue(history);
    const { container } = renderIt();
    await screen.findByText("History");
    const todayCell = () => container.querySelector(".cal__day--today .cal__count");
    expect(todayCell()?.textContent).toBe("7");
    fireEvent.click(within(container, ".hist-cal").getByRole("button", { name: "Cards reviewed" }));
    expect(todayCell()?.textContent).toBe("3");
  });

  it("lists confidence per level, easy → hard then unranked", async () => {
    getProfileHistory.mockResolvedValue(history);
    const { container } = renderIt();
    await screen.findByText("History");
    const labels = [...container.querySelectorAll(".hist-levels__label")].map((e) => e.textContent);
    expect(labels).toEqual(["N5", "Unranked"]);
  });

  it("shows the not-yet message for confidence over time until snapshots exist", async () => {
    getProfileHistory.mockResolvedValue(history);
    renderIt();
    await screen.findByText("History");
    fireEvent.change(screen.getByRole("combobox", { name: "What to show" }), { target: { value: "confidence" } });
    expect(screen.getByText(/recorded nightly/)).toBeTruthy();
  });
});

import { within as tlWithin } from "@testing-library/react";
function within(root: HTMLElement, sel: string) {
  return tlWithin(root.querySelector(sel) as HTMLElement);
}
