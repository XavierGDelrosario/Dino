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
const sw = () => screen.getByRole("switch");
const on = () => sw().getAttribute("aria-checked") === "true";

describe("GoalsPage — daily reminder", () => {
  it("turns on after permission, and OFF again on the next press", async () => {
    renderIt();
    await waitFor(() => expect(on()).toBe(false));
    fireEvent.click(sw());
    await waitFor(() => expect(on()).toBe(true));
    expect(JSON.parse(store.get("dino.reminder")!).enabled).toBe(true);
    fireEvent.click(sw());
    await waitFor(() => expect(on()).toBe(false));
    expect(JSON.parse(store.get("dino.reminder")!).enabled).toBe(false);
    expect(syncReminders).toHaveBeenCalledTimes(2);
  });

  it("when iOS has denied: the switch is off, Open Settings shows, and it turns on by itself once permission is granted on return", async () => {
    perm.check = "denied";
    renderIt();
    await waitFor(() => expect(screen.getByText("Notifications are off for DINO in iOS Settings")).toBeTruthy());
    expect(on()).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /open settings/i }));
    await waitFor(() => expect(openAppSettings).toHaveBeenCalled());
    perm.check = "granted";
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(on()).toBe(true));
    expect(screen.queryByText("Notifications are off for DINO in iOS Settings")).toBeNull();
    fireEvent.click(sw());
    await waitFor(() => expect(on()).toBe(false));
  });

  it("goes OFF (and offers Settings) when notifications are turned off in iOS while the reminder is on", async () => {
    perm.check = "granted";
    store.set("dino.reminder", JSON.stringify({ enabled: true, from: 1140, to: 1260 }));
    renderIt();
    await waitFor(() => expect(on()).toBe(true));
    perm.check = "denied";
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(on()).toBe(false));
    expect(screen.getByRole("button", { name: /open settings/i })).toBeTruthy();
    // ...and back on by itself when they are allowed again.
    perm.check = "granted";
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(on()).toBe(true));
  });
});
