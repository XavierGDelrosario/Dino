// The History calendar: one month, every day printing how many words were ADDED (or
// cards REVIEWED) on it, the square shaded by that count. Built on the same month-grid
// maths and .cal styles as the Lists date filter (lib/calendar) — read-only here, so
// the days are plain cells, not buttons.
import { useMemo, useState } from "react";
import { useI18n } from "../../i18n";
import { monthCells, weekdayNames } from "../../lib/calendar";
import { dayKey } from "../../services/words/filters";
import { dayCounts, type HistoryDay } from "../../services/history";
import "../lists/lists.css";
import "./history.css";

type CalMetric = "added" | "reviewed";

/** Sequential shading: one hue (the accent) from faint to strong, capped so the day
 *  number stays readable on the darkest cell. */
function heat(n: number, max: number): string | undefined {
  if (n <= 0 || max <= 0) return undefined;
  const pct = Math.round(12 + 43 * Math.min(1, n / max));
  return `color-mix(in srgb, var(--accent) ${pct}%, transparent)`;
}

export function HistoryCalendar({ days }: { days: HistoryDay[] }) {
  const { t, locale } = useI18n();
  const [metric, setMetric] = useState<CalMetric>("added");
  const [cursor, setCursor] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });

  const counts = useMemo(() => dayCounts(days, metric), [days, metric]);
  const cells = useMemo(() => monthCells(cursor, locale), [cursor, locale]);
  const weekdays = useMemo(() => weekdayNames(locale), [locale]);
  const title = useMemo(
    () => new Intl.DateTimeFormat(locale, { year: "numeric", month: "long" }).format(cursor),
    [cursor, locale],
  );
  // Shade relative to THIS month's busiest day, so a quiet month still shows its shape.
  const max = Math.max(0, ...cells.map((c) => (c ? counts.get(c.key) ?? 0 : 0)));

  const now = new Date();
  const atCurrentMonth =
    cursor.getFullYear() === now.getFullYear() && cursor.getMonth() === now.getMonth();
  const today = dayKey(now);
  const shift = (m: number) => setCursor((c) => new Date(c.getFullYear(), c.getMonth() + m, 1));

  return (
    <div className="hist-cal">
      <div className="hist__seg" role="group" aria-label={t("history.metricAria")}>
        {(["added", "reviewed"] as const).map((m) => (
          <button
            key={m}
            type="button"
            className={`hist__segbtn${metric === m ? " is-active" : ""}`}
            aria-pressed={metric === m}
            onClick={() => setMetric(m)}
          >
            {t(m === "added" ? "history.metricAdded" : "history.metricReviewed")}
          </button>
        ))}
      </div>

      <div className="cal__nav">
        <button type="button" className="cal__arrow" onClick={() => shift(-1)} aria-label={t("dates.prevMonth")}>
          ‹
        </button>
        <span className="cal__title">{title}</span>
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

      <div className="cal__grid">
        {weekdays.map((name, i) => (
          <span key={`wd-${i}`} className="cal__weekday" aria-hidden="true">
            {name}
          </span>
        ))}
        {cells.map((cell, i) => {
          if (cell === null) return <span key={`pad-${i}`} className="cal__pad" />;
          const n = counts.get(cell.key) ?? 0;
          const label = t("history.cellAria", { date: cell.label, n });
          return (
            <span
              key={cell.key}
              role="img"
              aria-label={label}
              title={label}
              className={`cal__day hist-cal__day${cell.key === today ? " cal__day--today" : ""}${
                cell.key > today ? " hist-cal__day--future" : ""
              }`}
              style={{ background: heat(n, max) }}
            >
              <span className="cal__num">{cell.day}</span>
              <span className="cal__count">{n > 0 ? n : ""}</span>
            </span>
          );
        })}
      </div>
    </div>
  );
}
