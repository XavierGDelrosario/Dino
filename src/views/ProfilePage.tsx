// Profile page: identity (email / date created) + the APP language (UI localization,
// the client-side i18n locale). The native/learning pickers were removed 2026-11-07:
// Japanese is the only learnable language, so each had one option. The pair still
// lives on `users` and is resolved by `resolveLanguagePair`; bring the pickers back
// (services/language `learningOptions` / `nativeOptions`) when a second one is learnable. History has its own page
// (/history, views/HistoryPage.tsx), linked from the account menu under Profile.
import { useEffect, useState } from "react";
import { BackLink } from "../components/common/BackLink";
import { getUserProfile } from "../services/session";
import { errorMessage } from "../lib/errorMessage";
import { useI18n, LOCALES, type Locale } from "../i18n";
import { ErrorText } from "../components/common/ErrorText";
import { Link } from "../router";
import "../components/common/common.css";

export function ProfilePage({
  userId,
  isAnonymous,
  email,
}: {
  userId: string;
  isAnonymous: boolean;
  email: string | null;
}) {
  const { t, locale, setLocale } = useI18n();
  const [created, setCreated] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    getUserProfile(userId)
      .then((p) => {
        if (!active || !p) return;
        setCreated(p.dateCreated);
      })
      .catch((e) => active && setErr(errorMessage(e)));
    return () => { active = false; };
  }, [userId]);

  const fmtDate = (iso: string) => new Date(iso).toLocaleDateString(locale, {
    year: "numeric", month: "long", day: "numeric",
  });

  return (
    <section className="profile">
      <BackLink />
      <h2 className="profile__title">{t("profile.title")}</h2>

      <div className="profile__row">
        <span className="profile__label">{t("auth.emailPlaceholder")}</span>
        <span>{isAnonymous ? t("profile.guest") : email}</span>
      </div>
      {created && (
        <div className="profile__row">
          <span className="profile__label">{t("profile.created")}</span>
          <span>{fmtDate(created)}</span>
        </div>
      )}
      <div className="profile__row">
        <label className="profile__label" htmlFor="pf-app">{t("profile.appLanguage")}</label>
        <select id="pf-app" className="select select--sm" value={locale} onChange={(e) => setLocale(e.target.value as Locale)}>
          {LOCALES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
        </select>
      </div>

      <ErrorText message={err} />

      {/* Footer: Delete account, centred. Back is the arrow at the top-left; sign-out
          lives in the top-right account menu; delete is its own confirmation page. */}
      {!isAnonymous && (
        <div className="profile__footer">
          <Link to="/delete-account" className="account__link profile__deletelink">
            {t("profile.deleteAccount")}
          </Link>
        </div>
      )}
    </section>
  );
}
