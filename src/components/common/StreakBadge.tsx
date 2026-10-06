// The 🔥 streak counter at the top-left of every page: the number of consecutive
// days studied, in the streak colour, and the way to /goals (streaks, daily goals,
// reminders). Hidden until the first answer, and for good on a database that has no
// study_days() yet (pre-20260790) — a counter that can't count would only confuse.
import { useI18n } from "../../i18n";
import { Link } from "../../router";
import { useStreak } from "../../hooks/useStreak";

export function StreakBadge({ userId }: { userId: string }) {
  const { t } = useI18n();
  const { streaks } = useStreak(userId);
  if (!streaks) return null;
  return (
    <Link
      to="/goals"
      className={`streak${streaks.studiedToday ? " streak--lit" : ""}`}
      ariaLabel={t("streak.aria", { n: streaks.current })}
      title={t("streak.title")}
    >
      <span className="streak__fire" aria-hidden="true">🔥</span>
      <span className="streak__n">{streaks.current}</span>
    </Link>
  );
}
