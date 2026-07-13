// A calendar-period filter dropdown (All time / Today / This week / This month
// / This year), rendered inside the filter menu. The DatePeriod type and its cutoff
// live with the rest of the filter model (services/words/filters.ts).
import { useI18n } from "../../i18n";
import type { DatePeriod } from "../../services/words/filters";
import "./lists.css";

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
  const { t } = useI18n();
  return (
    <select
      className="select select--sm"
      value={value}
      onChange={(e) => onChange(e.target.value as DatePeriod)}
      aria-label={ariaLabel}
    >
      <option value="all">{label}: {t("period.allTime")}</option>
      <option value="today">{label}: {t("period.today")}</option>
      <option value="week">{label}: {t("period.week")}</option>
      <option value="month">{label}: {t("period.month")}</option>
      <option value="year">{label}: {t("period.year")}</option>
    </select>
  );
}
