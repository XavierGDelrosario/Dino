// History page (/history): the calendar, activity/confidence plot and confidence by
// level (components/profile/HistorySection). Reached from the account menu, right
// under Profile. Accounts only (guests are sent to sign-up before this renders).
import { BackLink } from "../components/common/BackLink";
import { HistorySection } from "../components/profile/HistorySection";
import "../components/common/common.css";

export function HistoryPage({ userId }: { userId: string }) {
  return (
    <section className="profile">
      <BackLink />
      <HistorySection userId={userId} />
    </section>
  );
}
