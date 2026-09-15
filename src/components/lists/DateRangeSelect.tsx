// The added / last-reviewed filter axes: an inclusive span of calendar DAYS.
//
// Each axis is a DROPDOWN — all time · today · this week · this month · this year ·
// custom — because the named spans are the common ask and one pick answers them. Only
// "custom" opens the calendar, which is the tall part: the panel is in the page flow, so
// a calendar nobody asked for pushes the rows it filters down the page. The calendar has
// its own ✕, and every day in it prints how many words fall on it ("24" under the 3rd),
// so you can see WHERE your words are before choosing a span.
//
// The range model + its day maths live with the rest of the filter model
// (services/words/filters.ts); this file is only the surface.
import { useMemo, useState } from "react";
import { useI18n, plural, type Locale, type MessageKey, type TFn } from "../../i18n";
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

/** The dropdown's options. "custom" is the one that isn't a span by itself — it opens
 *  the calendar. */
type DateMode = DatePeriod | "custom";

const OPTIONS: { mode: DateMode; label: MessageKey }[] = [
  { mode: "all", label: "period.allTime" },
  { mode: "today", label: "period.today" },
  { mode: "week", label: "period.week" },
  { mode: "month", label: "period.month" },
  { mode: "year", label: "period.year" },
  { mode: "custom", label: "dates.custom" },
];

const PRESETS: DatePeriod[] = ["today", "week", "month", "year"];

/** Which named span a range IS, if any — so a stored "this week" reads back as "this
 *  week" rather than as two dates. Anything else that narrows is custom. */
function modeOf(r: DateRange): DateMode {
  if (!rangeNarrows(r)) return "all";
  const preset = PRESETS.find((p) => {
    const span = periodRange(p);
    return span.from === r.from && span.to === r.to;
  });
  return preset ?? "custom";
}

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

/** The whole span in one line — what the custom-range button reads. */
function summarize(r: DateRange, locale: Locale, t: TFn): string {
  if (!rangeNarrows(r)) return t("dates.pickDays");
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

/**
 * The custom-span calendar for one axis. Rendered by the panel BELOW both dropdowns at
 * full width (one at a time), so the day cells are big enough to carry a word count.
 */
export function DateRangeCalendar({
  label,
  value,
  onChange,
  onClose,
  counts,
}: {
  label: string;
  value: DateRange;
  onChange: (r: DateRange) => void;
  onClose: () => void;
  /** Words per local day (`YYYY-MM-DD`) on this axis; omitted → no numbers. */
  counts?: ReadonlyMap<string, number>;
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
      <div className="cal__head">
        <span className="cal__label">{label}</span>
        <button
          type="button"
          className="cal__close"
          onClick={onClose}
          aria-label={t("dates.close")}
          title={t("dates.close")}
        >
          ✕
        </button>
      </div>

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
        {cells.map((cell, i) => {
          if (cell === null) return <span key={`pad-${i}`} className="cal__pad" />;
          const n = counts?.get(cell.key) ?? 0;
          return (
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
              // The count is part of the name only when there is one, so a day reads
              // "Tuesday, March 3, 2026 — 24 words" and an empty day just its date.
              aria-label={
                n > 0
                  ? t("dates.dayWithCount", {
                      date: cell.label,
                      n,
                      noun: plural(t, n, "common.word", "common.words"),
                    })
                  : cell.label
              }
              // Only meaningful while anchored — that is the one state the highlight
              // follows — so an idle sweep across the grid re-renders nothing.
              onPointerEnter={anchor === null ? undefined : () => setHover(cell.key)}
              onClick={() => pick(cell.key)}
            >
              <span className="cal__num">{cell.day}</span>
              <span className="cal__count" aria-hidden="true">
                {n > 0 ? n : ""}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * One date axis: "Added [this week ▾]". Picking a named span applies it at once;
 * "custom" asks the panel to open this axis's calendar (`onOpenCalendar`), and while a
 * custom span is set a button reading it ("Mar 3 – Mar 9") re-opens the calendar.
 */
export function DateRangeSelect({
  label,
  value,
  onChange,
  ariaLabel,
  calendarOpen,
  onOpenCalendar,
}: {
  label: string;
  value: DateRange;
  onChange: (v: DateRange) => void;
  ariaLabel: string;
  calendarOpen: boolean;
  onOpenCalendar: (open: boolean) => void;
}) {
  const { t, locale } = useI18n();
  // "custom" was CHOSEN but no day picked yet: the range is still all-time, which would
  // otherwise read back as "all time" and snap the dropdown away from what was chosen.
  const [customPicked, setCustomPicked] = useState(false);
  const derived = modeOf(value);
  const mode: DateMode =
    customPicked && (calendarOpen || rangeNarrows(value)) ? "custom" : derived;

  const choose = (next: DateMode) => {
    if (next === "custom") {
      setCustomPicked(true);
      onOpenCalendar(true);
      return;
    }
    setCustomPicked(false);
    onOpenCalendar(false);
    onChange(next === "all" ? ANY_DATES : periodRange(next));
  };

  return (
    <div className="daterange">
      <label className="daterange__field">
        <span className="daterange__name">{label}</span>
        <select
          className={`select select--sm daterange__select${rangeNarrows(value) ? " daterange__select--on" : ""}`}
          value={mode}
          aria-label={ariaLabel}
          onChange={(e) => choose(e.target.value as DateMode)}
        >
          {OPTIONS.map((o) => (
            <option key={o.mode} value={o.mode}>
              {t(o.label)}
            </option>
          ))}
        </select>
      </label>
      {mode === "custom" && (
        <button
          type="button"
          className="daterange__custom"
          aria-expanded={calendarOpen}
          aria-label={t("dates.editCustom", { label })}
          onClick={() => onOpenCalendar(!calendarOpen)}
        >
          {summarize(value, locale, t)}
        </button>
      )}
    </div>
  );
}
