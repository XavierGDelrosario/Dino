// The profile's History section: the calendar, the line plot and confidence by level,
// all from ONE read (useProfileHistory). Renders nothing while loading and nothing at
// all when this database can't answer yet (pre-20260775) — a missing feature, not an
// error on the profile.
import { useI18n } from "../../i18n";
import { useProfileHistory } from "../../hooks/useProfileHistory";
import { ErrorText } from "../common/ErrorText";
import { HistoryCalendar } from "./HistoryCalendar";
import { HistoryPlot } from "./HistoryPlot";
import { ConfidenceByLevel } from "./ConfidenceByLevel";
import "./history.css";

export function HistorySection({ userId }: { userId: string }) {
  const { t } = useI18n();
  const { history, error } = useProfileHistory(userId);

  if (error) return <ErrorText message={error} />;
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
        <HistoryPlot history={history} />
      </div>

      <div className="hist__card">
        <h4 className="hist__subtitle">{t("history.byLevel")}</h4>
        <ConfidenceByLevel history={history} />
      </div>
    </section>
  );
}
