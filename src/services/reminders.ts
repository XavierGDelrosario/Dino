// Daily study reminders: a notification inside a time WINDOW the user picks on /goals
// (the dual-thumb slider). Settings live in localStorage — a reminder is a DEVICE
// thing: permission is granted per device and the notification is scheduled on the
// device, so there is nothing for another device to share.
//
// Delivery is @capacitor/local-notifications on every platform. On iOS that is a real
// scheduled local notification, delivered with the app closed. On the web the plugin
// falls back to the Notification API with a timer, so a reminder only arrives while
// DINO is open in a tab — the page says so. (A service worker + push would lift that;
// docs/TODO.md.)
//
// THE WINDOW. Both thumbs mean something: the first reminder fires at the START, and
// if the window has an END later than the start, a second "last call" fires there.
// Rather than one repeating rule (which can't skip a day already studied), the next
// 7 days are scheduled as individual moments every time the app syncs — on launch and
// whenever the settings or today's activity change — so a day you have already studied
// gets no nag, and the horizon keeps rolling forward as long as the app is opened
// weekly. The maths is pure (reminderMoments) and pinned by tests.
import { Capacitor } from "@capacitor/core";
import { LocalNotifications, type LocalNotificationSchema } from "@capacitor/local-notifications";

export interface ReminderSettings {
  enabled: boolean;
  /** Window start, minutes after local midnight (a multiple of STEP_MINUTES). */
  from: number;
  /** Window end, minutes after local midnight. Equal to `from` = one reminder only. */
  to: number;
}

export const STEP_MINUTES = 30;
export const MIN_MINUTES = 0;
export const MAX_MINUTES = 23 * 60 + 30;
/** Evening by default — the slot most people can protect. */
export const DEFAULT_REMINDER: ReminderSettings = { enabled: false, from: 19 * 60, to: 21 * 60 };

/** How many days ahead moments are scheduled on each sync. */
export const HORIZON_DAYS = 7;
/** Our notification ids: HORIZON_DAYS × 2 slots, well away from anything else. */
const ID_BASE = 7000;

const STORAGE_KEY = "dino.reminder";

export function loadReminderSettings(): ReminderSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_REMINDER;
    const p = JSON.parse(raw) as Partial<ReminderSettings>;
    const clamp = (v: unknown, d: number) =>
      typeof v === "number" && Number.isFinite(v) ? Math.max(MIN_MINUTES, Math.min(MAX_MINUTES, v)) : d;
    return {
      enabled: p.enabled === true,
      from: clamp(p.from, DEFAULT_REMINDER.from),
      to: clamp(p.to, DEFAULT_REMINDER.to),
    };
  } catch {
    return DEFAULT_REMINDER;
  }
}

export function saveReminderSettings(s: ReminderSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* private mode — the choice lives for this page only */
  }
}

/** The window the thumbs span, whichever order they were dragged into. */
export function reminderWindow(s: ReminderSettings): { from: number; to: number } {
  return { from: Math.min(s.from, s.to), to: Math.max(s.from, s.to) };
}

/** `19:00` from minutes after midnight. */
export function formatMinutes(m: number, locale = "en"): string {
  const d = new Date(2000, 0, 1, Math.floor(m / 60), m % 60);
  return d.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
}

/**
 * Every moment to schedule from `now`: for each of the next HORIZON_DAYS days, the
 * window start and (when it differs) the window end. Today is skipped when it has
 * already been studied, and a moment already behind us is never scheduled.
 */
export function reminderMoments(s: ReminderSettings, now: Date, studiedToday: boolean): Date[] {
  const { from, to } = reminderWindow(s);
  const slots = from === to ? [from] : [from, to];
  const out: Date[] = [];
  for (let day = 0; day < HORIZON_DAYS; day++) {
    if (day === 0 && studiedToday) continue;
    for (const minutes of slots) {
      const at = new Date(now.getFullYear(), now.getMonth(), now.getDate() + day, 0, minutes, 0, 0);
      if (at.getTime() > now.getTime()) out.push(at);
    }
  }
  return out;
}

export type ReminderSupport = "native" | "web" | "none";

/** Whether this device can show a reminder at all, and how well. */
export function reminderSupport(): ReminderSupport {
  if (Capacitor.isNativePlatform()) return "native";
  return typeof window !== "undefined" && "Notification" in window ? "web" : "none";
}

export type ReminderPermission = "granted" | "denied" | "prompt";

const toPermission = (display: string): ReminderPermission =>
  display === "granted" ? "granted" : display === "denied" ? "denied" : "prompt";

export async function checkReminderPermission(): Promise<ReminderPermission> {
  if (reminderSupport() === "none") return "denied";
  try {
    const r = await LocalNotifications.checkPermissions();
    return toPermission(r.display);
  } catch {
    return "denied";
  }
}

/** Ask the OS/browser. Resolves to the resulting state (the user may say no). */
export async function requestReminderPermission(): Promise<ReminderPermission> {
  if (reminderSupport() === "none") return "denied";
  try {
    const r = await LocalNotifications.requestPermissions();
    return toPermission(r.display);
  } catch {
    return "denied";
  }
}

export interface ReminderCopy {
  title: string;
  body: string;
}

const ourIds = () => Array.from({ length: HORIZON_DAYS * 2 }, (_, i) => ({ id: ID_BASE + i }));

/**
 * Replace whatever is pending with the moments the current settings call for — or
 * nothing, when reminders are off or not permitted. Safe to call often; it is the
 * ONLY writer of our notification ids, so it always starts by cancelling them.
 */
export async function syncReminders(
  settings: ReminderSettings,
  copy: ReminderCopy,
  studiedToday: boolean,
  now = new Date(),
): Promise<void> {
  if (reminderSupport() === "none") return;
  try {
    await LocalNotifications.cancel({ notifications: ourIds() });
    if (!settings.enabled) return;
    if ((await checkReminderPermission()) !== "granted") return;
    const notifications: LocalNotificationSchema[] = reminderMoments(settings, now, studiedToday).map(
      (at, i) => ({
        id: ID_BASE + i,
        title: copy.title,
        body: copy.body,
        schedule: { at, allowWhileIdle: true },
      }),
    );
    if (notifications.length) await LocalNotifications.schedule({ notifications });
  } catch (e) {
    // Best-effort: a reminder that fails to schedule must never break the page.
    console.warn("[reminders] could not schedule", e);
  }
}
