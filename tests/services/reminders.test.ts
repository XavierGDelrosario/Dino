// The reminder window arithmetic: both thumbs mean something (start + last call), a
// studied day gets no nag, past moments are never scheduled, and the thumbs may cross.
import { describe, it, expect, beforeEach } from "vitest";
import {
  DEFAULT_REMINDER,
  HORIZON_DAYS,
  formatMinutes,
  loadReminderSettings,
  reminderMoments,
  reminderWindow,
  saveReminderSettings,
} from "@/services/reminders";

const at = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo - 1, d, h, mi);

describe("reminderMoments", () => {
  const settings = { enabled: true, from: 19 * 60, to: 21 * 60 };

  it("schedules a start and a last call for each coming day", () => {
    const now = at(2026, 10, 6, 9);
    const m = reminderMoments(settings, now, false);
    expect(m).toHaveLength(HORIZON_DAYS * 2);
    expect(m[0]).toEqual(at(2026, 10, 6, 19));
    expect(m[1]).toEqual(at(2026, 10, 6, 21));
    expect(m[2]).toEqual(at(2026, 10, 7, 19));
  });

  it("skips today once it has been studied", () => {
    const m = reminderMoments(settings, at(2026, 10, 6, 9), true);
    expect(m[0]).toEqual(at(2026, 10, 7, 19));
    expect(m).toHaveLength((HORIZON_DAYS - 1) * 2);
  });

  it("never schedules a moment that has passed, but keeps the rest of today", () => {
    const m = reminderMoments(settings, at(2026, 10, 6, 20), false);
    expect(m[0]).toEqual(at(2026, 10, 6, 21));
  });

  it("fires once a day when both thumbs sit on the same time", () => {
    const m = reminderMoments({ enabled: true, from: 480, to: 480 }, at(2026, 10, 6, 0), false);
    expect(m).toHaveLength(HORIZON_DAYS);
    expect(m[0]).toEqual(at(2026, 10, 6, 8));
  });

  it("reads crossed thumbs as min..max", () => {
    expect(reminderWindow({ enabled: true, from: 1260, to: 1140 })).toEqual({ from: 1140, to: 1260 });
    const m = reminderMoments({ enabled: true, from: 1260, to: 1140 }, at(2026, 10, 6, 0), false);
    expect(m[0]).toEqual(at(2026, 10, 6, 19));
  });

  it("crosses a month boundary", () => {
    const m = reminderMoments({ enabled: true, from: 600, to: 600 }, at(2026, 10, 31, 12), false);
    expect(m[0]).toEqual(at(2026, 11, 1, 10));
  });
});

describe("formatMinutes", () => {
  it("prints a wall-clock time", () => {
    expect(formatMinutes(19 * 60, "en-US")).toMatch(/^7:00\sPM$/);
    expect(formatMinutes(30, "en-US")).toMatch(/^12:30\sAM$/);
    expect(formatMinutes(19 * 60, "ja")).toBe("19:00");
  });
});

describe("settings storage", () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: () => null,
      length: 0,
    } as Storage;
  });

  it("round-trips, and falls back to the default on garbage", () => {
    expect(loadReminderSettings()).toEqual(DEFAULT_REMINDER);
    saveReminderSettings({ enabled: true, from: 600, to: 660 });
    expect(loadReminderSettings()).toEqual({ enabled: true, from: 600, to: 660 });
    store.set("dino.reminder", "{nope");
    expect(loadReminderSettings()).toEqual(DEFAULT_REMINDER);
    store.set("dino.reminder", JSON.stringify({ enabled: true, from: 99999, to: -5 }));
    expect(loadReminderSettings()).toEqual({ enabled: true, from: 23 * 60 + 30, to: 0 });
  });
});
