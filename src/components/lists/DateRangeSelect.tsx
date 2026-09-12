// The added / last-reviewed filter axes: an inclusive span of calendar DAYS, picked
// on a calendar rather than chosen from a list of canned periods.
//
// It replaced a five-option <select> (All time / Today / This week / This month /
// This year), which could only ever express "since <a boundary the code chose>" —
// there was no way to ask for the words you added on the trip in May, and no upper
// bound at all. The presets survive as one row inside the calendar, because "this
// week" is still the common ask and two clicks plus month navigation is a bad way to
// answer it.
//
// The range model + its day maths live with the rest of the filter model
// (services/words/filters.ts); this file is only the surface.
import { useMemo, useState } from "react";
import { useI18n, type Locale, type MessageKey, type TFn } from "../../i18n";
import {
  ANY_DATES,
  dayKey,
  parseDayKey,
  periodRange,
  rangeNarrows,
  type DatePeriod,
  type DateRange,
} from "../../services/words/filters";
import "./lists.css";

const PRESETS: { period: DatePeriod; label: MessageKey }[] = [
  { period: "today", label: "period.today" },
  { period: "week", label: "period.week" },
  { period: "month", label: "period.month" },
  { period: "year", label: "period.year" },
];

/** Ordered ends of a span. Both set → sorted (they may arrive either way round, see
 *  rangeBounds); one set → it keeps its own side, so a half-open span stays half-open. */
function ends(a: string | null, b: string | null): [string | null, string | null] {
  if (a && b) return a <= b ? [a, b] : [b, a];
  return [a, b];
}

/** A day key → a short date in the UI locale. The YEAR appears only when it isn't the
 *  current one — it is noise on the common case and load-bearing on the rare one. */
function fmtDay(key: string, locale: Locale): string {
  const d = parseDayKey(key);
  return d.toLocaleDateString(
    locale,
    d.getFullYear() === new Date().getFullYear()
      ? { month: "short", day: "numeric" }
      : { year: "numeric", month: "short", day: "numeric" },
  );
}

/** The whole span in one line — what the closed trigger reads. */
function summarize(r: DateRange, locale: Locale, t: TFn): string {
  if (!rangeNarrows(r)) return t("period.allTime");
  const [lo, hi] = ends(r.from, r.to);
  if (lo && hi && lo === hi) return fmtDay(lo, locale);
  if (lo && hi) return t("dates.span", { from: fmtDay(lo, locale), to: fmtDay(hi, locale) });
  if (r.from) return t("dates.since", { date: fmtDay(r.from, locale) });
  return t("dates.until", { date: fmtDay(r.to as string, locale) });
}

/** The seven weekday initials in the UI locale. 2024-01-01 was a Monday, so the week
 *  is generated from real dates rather than a hand-written list per language. */
function weekdayNames(locale: Locale): string[] {
  const fmt = new Intl.DateTimeFormat(locale, { weekday: "short" });
  return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(2024, 0, 1 + i)));
}

/** One month as 7-column rows: leading/trailing blanks rather than the neighbouring
 *  month's days, so every clickable square belongs to the month in the title.
 *
 *  Each cell carries its finished label and day NUMBER, because everything here
 *  depends only on the month and the locale — building it in the render body meant
 *  re-deriving ~42 cells and constructing a fresh `Intl` formatter per cell on every
 *  pointer move across the grid. */
interface Cell {
  key: string;
  day: number;
  label: string;
}

function monthCells(cursor: Date, locale: Locale): (Cell | null)[] {
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
  const cells: (Cell | null)[] = Array.from({ length: lead }, () => null);
  for (let d = 1; d <= length; d++) {
    const date = new Date(year, month, d);
    cells.push({ key: dayKey(date), day: d, label: fmt.format(date) });
  }
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

function Calendar({
  label,
  value,
  onChange,
}: {
  label: string;
  value: DateRange;
  onChange: (r: DateRange) => void;
}) {
  const { t, locale } = useI18n();
  const today = dayKey(new Date());
  // The month on screen. Opens on the span's start so re-opening a filter shows what
  // it selected, not whatever month it is now.
  const [cursor, setCursor] = useState(() => {
    const at = value.from ?? value.to;
    const d = at ? parseDayKey(at) : new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  // The half-made selection: the first click sets both ends to one day and waits for
  // the second to open it out. Null = the next click starts a NEW span rather than
  // extending the one on screen — otherwise a range could only ever grow.
  const [anchor, setAnchor] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);

  // While anchored, the highlight follows the cursor: the span you WOULD get, drawn
  // before you commit to it.
  const [lo, hi] = anchor ? ends(anchor, hover ?? anchor) : ends(value.from, value.to);
  const inSpan = (day: string) => (!lo || day >= lo) && (!hi || day <= hi) && (!!lo || !!hi);

  const pick = (day: string) => {
    if (anchor === null) {
      setAnchor(day);
      onChange({ from: day, to: day });
    } else {
      const [from, to] = ends(anchor, day);
      setAnchor(null);
      onChange({ from, to });
    }
  };

  const shift = (months: number) =>
    setCursor((c) => new Date(c.getFullYear(), c.getMonth() + months, 1));

  const now = new Date();
  const atCurrentMonth =
    cursor.getFullYear() === now.getFullYear() && cursor.getMonth() === now.getMonth();
  // The month grid, its heading and the weekday strip depend on the month and the
  // locale ONLY — never on `hover`, which changes on every cell the pointer crosses.
  const title = useMemo(
    () => new Intl.DateTimeFormat(locale, { year: "numeric", month: "long" }).format(cursor),
    [cursor, locale],
  );
  const cells = useMemo(() => monthCells(cursor, locale), [cursor, locale]);
  const weekdays = useMemo(() => weekdayNames(locale), [locale]);

  return (
    <div className="cal" role="group" aria-label={t("dates.calendarAria", { label })}>
      <div className="cal__nav">
        <button
          type="button"
          className="cal__arrow"
          onClick={() => shift(-1)}
          aria-label={t("dates.prevMonth")}
        >
          ‹
        </button>
        <span className="cal__title">{title}</span>
        {/* Forward is capped at the current month: nothing can have been added or
            reviewed in the future, so those months hold no words to select. */}
        <button
          type="button"
          className="cal__arrow"
          onClick={() => shift(1)}
          disabled={atCurrentMonth}
          aria-label={t("dates.nextMonth")}
        >
          ›
        </button>
      </div>

      <div className="cal__grid" onPointerLeave={() => setHover(null)}>
        {weekdays.map((name, i) => (
          <span key={`wd-${i}`} className="cal__weekday" aria-hidden="true">
            {name}
          </span>
        ))}
        {cells.map((cell, i) =>
          cell === null ? (
            <span key={`pad-${i}`} className="cal__pad" />
          ) : (
            <button
              key={cell.key}
              type="button"
              className={[
                "cal__day",
                inSpan(cell.key) ? " cal__day--in" : "",
                cell.key === lo || cell.key === hi ? " cal__day--edge" : "",
                cell.key === today ? " cal__day--today" : "",
              ].join("")}
              disabled={cell.key > today}
              aria-pressed={inSpan(cell.key)}
              aria-label={cell.label}
              // Only meaningful while anchored — that is the one state the highlight
              // follows — so an idle sweep across the grid re-renders nothing.
              onPointerEnter={anchor === null ? undefined : () => setHover(cell.key)}
              onClick={() => pick(cell.key)}
            >
              {cell.day}
            </button>
          ),
        )}
      </div>

      {/* The old <select>'s options, kept as one-click answers to the common asks. */}
      <div className="cal__presets">
        <button
          type="button"
          className="cal__preset"
          onClick={() => {
            setAnchor(null);
            onChange(ANY_DATES);
          }}
        >
          {t("period.allTime")}
        </button>
        {PRESETS.map((p) => (
          <button
            key={p.period}
            type="button"
            className="cal__preset"
            onClick={() => {
              setAnchor(null);
              const r = periodRange(p.period);
              setCursor(parseDayKey(r.from as string));
              onChange(r);
            }}
          >
            {t(p.label)}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * One date axis: a trigger reading "Added: Mar 3 – Mar 9", and the calendar below it
 * when open. WHICH axis is open is the caller's state, so opening one closes the
 * other — two calendars side by side in a half-width column is unreadable, and the
 * panel is in the page flow (never floating), so an open one pushes the rows down.
 */
export function DateRangeSelect({
  label,
  value,
  onChange,
  ariaLabel,
  open,
  onToggle,
}: {
  label: string;
  value: DateRange;
  onChange: (v: DateRange) => void;
  ariaLabel: string;
  open: boolean;
  onToggle: () => void;
}) {
  const { t, locale } = useI18n();
  const narrowed = rangeNarrows(value);
  return (
    <div className="daterange">
      <button
        type="button"
        className={`daterange__trigger${narrowed ? " daterange__trigger--on" : ""}`}
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={onToggle}
      >
        <span className="daterange__name">{label}</span>
        <span className="daterange__value">{summarize(value, locale, t)}</span>
      </button>
      {open && <Calendar label={label} value={value} onChange={onChange} />}
    </div>
  );
}
