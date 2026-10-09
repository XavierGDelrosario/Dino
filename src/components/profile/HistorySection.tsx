// The profile's History section: the calendar, the line plot and confidence by level,
// all from ONE read (useProfileHistory). Shows the loader while loading and nothing at
// all when this database can't answer yet (pre-20260775) — a missing feature, not an
// error on the profile.
import { useI18n } from "../../i18n";
import { useProfileHistory } from "../../hooks/useProfileHistory";
import { useGoals } from "../../hooks/useGoals";
import { ErrorText } from "../common/ErrorText";
import { PageLoading } from "../common/Loading";
import { HistoryCalendar } from "./HistoryCalendar";
import { HistoryPlot } from "./HistoryPlot";
import { ConfidenceByLevel } from "./ConfidenceByLevel";
import "./history.css";

export function HistorySection({ userId }: { userId: string }) {
  const { t } = useI18n();
  const { history, loading, error } = useProfileHistory(userId);
  // The daily goals (/goals) draw as a reference line on the activity plots.
  const { goals } = useGoals(userId);

  if (error) return <ErrorText message={error} />;
  // Loading: the mascot, not nothing — an empty page left only the footer on screen.
  if (loading) return <PageLoading />;
  if (!history) return null;

  return (
    <section className="hist" aria-labelledby="hist-title">
      <h3 id="hist-title" className="hist__title">
        {t("history.title")}
      </h3>

      <div className="hist__card">
        <h4 className="hist__subtitle">{t("history.calendar")}</h4>
        <HistoryCalendar days={history.days} />
      </div>

      <div className="hist__card">
        <h4 className="hist__subtitle">{t("history.plot")}</h4>
        <HistoryPlot history={history} goals={goals} />
      </div>

      <div className="hist__card">
        <h4 className="hist__subtitle">{t("history.byLevel")}</h4>
        <ConfidenceByLevel history={history} />
      </div>
    </section>
  );
}
