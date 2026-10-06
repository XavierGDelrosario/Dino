// @vitest-environment jsdom
// The Daily reminder button: Turn on → On (after permission), On → off again, and the
// iOS-denied path where the button becomes Open Settings and the reminder turns itself
// on when the user returns with permission granted.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, act } from "@testing-library/react";
import { LocaleProvider } from "@/i18n";
import { RouterProvider } from "@/router";

const perm = { check: "prompt" as "prompt" | "granted" | "denied", request: "granted" as "prompt" | "granted" | "denied" };
const syncReminders = vi.fn(() => Promise.resolve());
vi.mock("@/services/reminders", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/services/reminders")>();
  return {
    ...mod,
    reminderSupport: () => "native",
    checkReminderPermission: async () => perm.check,
    requestReminderPermission: async () => perm.request,
    syncReminders: (...a: unknown[]) => syncReminders(...(a as [])),
  };
});
const openAppSettings = vi.fn(() => Promise.resolve(true));
const settings = { can: true };
vi.mock("@/services/appSettings", () => ({
  canOpenAppSettings: () => settings.can,
  openAppSettings: () => openAppSettings(),
}));
vi.mock("@/hooks/useStreak", () => ({
  useStreak: () => ({ days: [], streaks: { current: 0, longest: 0, studiedToday: false }, today: { added: 0, reviews: 0 }, refresh: () => Promise.resolve() }),
}));
vi.mock("@/hooks/useGoals", () => ({
  useGoals: () => ({ goals: { newWords: 5, reviews: 20 }, loaded: true, error: null, update: async () => {} }),
}));

import { GoalsPage } from "@/views/GoalsPage";

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  syncReminders.mockClear();
  openAppSettings.mockClear();
  perm.check = "prompt";
  perm.request = "granted";
  settings.can = true;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k), clear: () => store.clear(), key: () => null, length: 0 },
  });
});
afterEach(cleanup);

const renderIt = () =>
  render(
    <RouterProvider>
      <LocaleProvider>
        <GoalsPage userId="u1" />
      </LocaleProvider>
    </RouterProvider>,
  );
const button = () => screen.getByRole("button", { name: /turn on|^on$|open settings/i });

describe("GoalsPage — daily reminder", () => {
  it("turns on after permission, and OFF again on the next press", async () => {
    renderIt();
    await waitFor(() => expect(button().textContent).toBe("Turn on"));
    fireEvent.click(button());
    await waitFor(() => expect(button().textContent).toBe("On"));
    expect(JSON.parse(store.get("dino.reminder")!).enabled).toBe(true);
    fireEvent.click(button());
    await waitFor(() => expect(button().textContent).toBe("Turn on"));
    expect(JSON.parse(store.get("dino.reminder")!).enabled).toBe(false);
    expect(syncReminders).toHaveBeenCalledTimes(2);
  });

  it("when iOS has denied: Open Settings, then on by itself once permission is granted on return", async () => {
    perm.check = "denied";
    renderIt();
    await waitFor(() => expect(button().textContent).toBe("Open Settings"));
    fireEvent.click(button());
    await waitFor(() => expect(openAppSettings).toHaveBeenCalled());
    perm.check = "granted";
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(button().textContent).toBe("On"));
    fireEvent.click(button());
    await waitFor(() => expect(button().textContent).toBe("Turn on"));
  });
});
