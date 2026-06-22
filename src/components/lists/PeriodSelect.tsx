// A calendar-period filter dropdown (All time / Today / This week / This month
// / This year) and the matching cutoff helper. Owns the DatePeriod type so the
// list view and this control share one definition.
import "./lists.css";

export type DatePeriod = "all" | "today" | "week" | "month" | "year";

/** Earliest timestamp included by a period ("today"=since midnight, "week"=since
 *  Monday, "month"=since the 1st, "year"=since Jan 1). */
// eslint-disable-next-line react-refresh/only-export-components -- type + cutoff helper are intentionally co-located with the control (see header).
export function periodCutoff(period: DatePeriod): number {
  if (period === "all") return -Infinity;
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  if (period === "week") d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  else if (period === "month") d.setDate(1);
  else if (period === "year") d.setMonth(0, 1);
  return d.getTime();
}

export function PeriodSelect({
  label,
  value,
  onChange,
  ariaLabel,
}: {
  label: string;
  value: DatePeriod;
  onChange: (v: DatePeriod) => void;
  ariaLabel: string;
}) {
  return (
    <select
      className="select select--sm"
      value={value}
      onChange={(e) => onChange(e.target.value as DatePeriod)}
      aria-label={ariaLabel}
    >
      <option value="all">{label}: all time</option>
      <option value="today">{label}: today</option>
      <option value="week">{label}: this week</option>
      <option value="month">{label}: this month</option>
      <option value="year">{label}: this year</option>
    </select>
  );
}
