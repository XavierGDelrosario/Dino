// History page (/history): the calendar, activity/confidence plot and confidence by
// level (components/profile/HistorySection). Reached from the account menu, right
// under Profile. Accounts only (guests are sent to sign-up before this renders).
import { useI18n } from "../i18n";
import { Link } from "../router";
import { HistorySection } from "../components/profile/HistorySection";
import "../components/common/common.css";

export function HistoryPage({ userId }: { userId: string }) {
  const { t } = useI18n();
  return (
    <section className="profile">
      <HistorySection userId={userId} />
      <div className="profile__footer">
        <Link to="/" className="account__link">{t("profile.back")}</Link>
      </div>
    </section>
  );
}
