// =========================================================
// Translate history — what you translated on THIS DEVICE (pure list mechanics + the
// device store; both tested).
//
// DEVICE ONLY, by decision (2026-10-06). It used to be session-only; it now survives a
// restart, kept in this browser's / this app's local storage and nowhere else:
//   · nothing is sent to the server — no table, no policy, no row to grow, and nothing
//     of what someone looked up exists outside the device they looked it up on;
//   · it does not follow the user between their phone and the web (the accepted cost);
//   · it is kept per USER id, so a sign-in never shows the previous person's lookups,
//     and it is erased on sign-out and on account deletion (session.ts) — a shared or
//     borrowed device keeps no record once the user leaves;
//   · it is capped (MAX_HISTORY), and "Clear" in the menu empties it.
//
// An entry stores the DIRECTION alongside the text because replaying it must
// reproduce the original translation. The same string means different things in
// different directions (愛 JA→EN vs ZH→EN), so text alone would replay a lookup the
// user never made. The raw `SourceSelection` is kept rather than the resolved
// language, so an entry submitted under auto-detect replays as auto-detect.
// =========================================================

import type { LangCode, SourceSelection } from "./language";

export interface TranslateHistoryEntry {
  /** Exactly what was submitted, trimmed — the text a replay re-runs. */
  text: string;
  /** Source as CHOSEN (may be auto-detect), so a replay resolves the same way. */
  source: SourceSelection;
  target: LangCode;
  /** When it was translated (epoch ms), for the date shown beside it. Optional: an
   *  entry stored before dates were kept has none, and simply shows no date. */
  at?: number;
}

/**
 * How many entries are kept. The menu scrolls, so this is a storage bound rather than a
 * display one: 200 single words is ~20 KB, and 200 paragraphs at the 2,000-character
 * limit is under 1 MB of the ~5 MB a site gets.
 */
export const MAX_HISTORY = 200;

/** The local calendar day an entry was translated on, as the menu prints it ("Oct 6",
 *  with the year once it isn't this one), or "" for an entry with no date. */
export function entryDate(entry: TranslateHistoryEntry, locale?: string, now: Date = new Date()): string {
  if (entry.at == null) return "";
  const d = new Date(entry.at);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
    ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  });
}

/** Identity of an entry — text AND direction (see the header note). */
export function entryKey(entry: TranslateHistoryEntry): string {
  return `${entry.source}\0${entry.target}\0${entry.text}`;
}

/**
 * Add `entry` to the front of `list`, most-recent-first.
 *
 * Re-submitting something already in the list MOVES it to the front rather than
 * duplicating — during a study session you re-translate the same phrase often, and
 * a history that fills with one repeated string is useless. Returns a new array;
 * `list` is never mutated (it is React state).
 *
 * An empty/whitespace-only `text` is dropped: submit already refuses those, so an
 * entry like that could only come from a caller bypassing the guard.
 */
export function pushEntry(
  list: readonly TranslateHistoryEntry[],
  entry: TranslateHistoryEntry,
  cap: number = MAX_HISTORY,
  now: number = Date.now(),
): TranslateHistoryEntry[] {
  const text = entry.text.trim();
  if (!text) return [...list];

  // Stamped HERE unless the caller already dated it: a re-translated entry moves to the
  // front with today's date, which is what "most recent first" promises.
  const next: TranslateHistoryEntry = { ...entry, text, at: entry.at ?? now };
  const key = entryKey(next);
  return [next, ...list.filter((e) => entryKey(e) !== key)].slice(0, Math.max(0, cap));
}

// ── The device store ────────────────────────────────────────────────────────
// localStorage, one key per user. Best-effort like every other use of it here: it can
// be missing, blocked or full, and every access is guarded — the fallback is a history
// that lasts the session, which is what there was before.

const keyFor = (userId: string) => `dino.translateHistory.${userId}`;

function isEntry(v: unknown): v is TranslateHistoryEntry {
  const e = v as Partial<TranslateHistoryEntry> | null;
  return (
    !!e &&
    typeof e.text === "string" &&
    typeof e.source === "string" &&
    typeof e.target === "string" &&
    (e.at === undefined || typeof e.at === "number")
  );
}

/** The history kept on this device for `userId` (newest first), or [] . */
export function loadHistory(userId: string): TranslateHistoryEntry[] {
  try {
    const raw = localStorage.getItem(keyFor(userId));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(isEntry).slice(0, MAX_HISTORY) : [];
  } catch {
    return [];
  }
}

/**
 * Keep `list` as `userId`'s history on this device. An empty list removes the key. If
 * the store is full, the OLDER half is dropped and it is tried once more — recent
 * lookups are the ones worth keeping.
 */
export function saveHistory(userId: string, list: readonly TranslateHistoryEntry[]): void {
  try {
    if (list.length === 0) {
      localStorage.removeItem(keyFor(userId));
      return;
    }
    try {
      localStorage.setItem(keyFor(userId), JSON.stringify(list));
    } catch {
      localStorage.setItem(keyFor(userId), JSON.stringify(list.slice(0, Math.ceil(list.length / 2))));
    }
  } catch {
    /* unavailable or still full: the in-memory list covers this session */
  }
}

/** Erase `userId`'s history from this device (sign-out, account deletion). */
export function forgetHistory(userId: string | null | undefined): void {
  if (!userId) return;
  try {
    localStorage.removeItem(keyFor(userId));
  } catch {
    /* nothing stored, or storage unavailable */
  }
}
