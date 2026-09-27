// The month-grid maths shared by every calendar (the Lists date filter and the
// profile's History calendar). Weeks start on MONDAY, and days are LOCAL (dayKey).
import { dayKey } from "../services/words/filters";

/** The seven weekday initials in the UI locale. 2024-01-01 was a Monday, so the week
 *  is generated from real dates rather than a hand-written list per language. */
export function weekdayNames(locale: string): string[] {
  const fmt = new Intl.DateTimeFormat(locale, { weekday: "short" });
  return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(2024, 0, 1 + i)));
}

/** One day square: its local key, day NUMBER and finished accessible label. */
export interface CalendarCell {
  key: string;
  day: number;
  label: string;
}

/** One month as 7-column rows: leading/trailing blanks rather than the neighbouring
 *  month's days, so every square belongs to the month in the title.
 *
 *  Each cell carries its finished label and day NUMBER, because everything here
 *  depends only on the month and the locale — building it in the render body meant
 *  re-deriving ~42 cells and constructing a fresh `Intl` formatter per cell on every
 *  pointer move across the grid. */
export function monthCells(cursor: Date, locale: string): (CalendarCell | null)[] {
  const year = cursor.getFullYear();
  const month = cursor.getMonth();
  const lead = (new Date(year, month, 1).getDay() + 6) % 7;
  const length = new Date(year, month + 1, 0).getDate();
  const fmt = new Intl.DateTimeFormat(locale, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const cells: (CalendarCell | null)[] = Array.from({ length: lead }, () => null);
  for (let d = 1; d <= length; d++) {
    const date = new Date(year, month, d);
    cells.push({ key: dayKey(date), day: d, label: fmt.format(date) });
  }
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}
