// The notice shown when a save is refused by a per-user row cap (services/rowLimit):
// for a GUEST it is the account prompt — the cap is the guest's, and creating an
// account lifts it while keeping every saved word (same uid); for an account it says
// the ceiling has been reached and what to do. Rendered ONCE, in the app shell, so it
// appears wherever the save was attempted (Translate, a quiz, Learn, Articles, Lists).
// Dismissible; the next refused save shows it again.
import { useEffect, useState } from "react";
import { useI18n } from "../../i18n";
import { Link } from "../../router";
import { onRowLimit, type RowLimitHit } from "../../services/rowLimit";

export function RowLimitNotice({ userId, isAnonymous }: { userId: string; isAnonymous: boolean }) {
  const { t } = useI18n();
  const [hit, setHit] = useState<RowLimitHit | null>(null);

  useEffect(() => onRowLimit(setHit), []);
  // A different user starts clean — the cap that was hit was the previous one's.
  useEffect(() => setHit(null), [userId]);

  if (!hit) return null;
  const n = hit.max.toLocaleString();
  const words = hit.table === "user_words";
  const what = words ? "words" : hit.table === "lists" ? "lists" : "articles";

  return (
    <div className="limitnotice" role="status">
      <p className="limitnotice__text">
        {isAnonymous
          ? t(words ? "limit.guestWords" : "limit.guestOther", { n, what: t(`limit.what.${what}`) })
          : t(words ? "limit.accountWords" : "limit.accountOther", { n, what: t(`limit.what.${what}`) })}
      </p>
      <div className="limitnotice__actions">
        {isAnonymous && (
          <Link to="/signup" className="btn btn--primary" onClick={() => setHit(null)}>
            {t("limit.createAccount")}
          </Link>
        )}
        <button type="button" className="btn" onClick={() => setHit(null)}>
          {t("limit.dismiss")}
        </button>
      </div>
    </div>
  );
}
