// Profile page: identity (email / date created) + the three language settings —
// NATIVE (default translation output), LEARNING (the language studied + default input),
// and APP language (UI localization). Native/learning persist on `users` (follow the
// account); app language is the client-side i18n locale. History has its own page
// (/history, views/HistoryPage.tsx), linked from the account menu under Profile.
import { useEffect, useState } from "react";
import { BackLink } from "../components/common/BackLink";
import { getUserProfile, updateUserLanguages } from "../services/session";
import { targetOptions, defaultLanguagePair, resolveLanguagePair } from "../services/language";
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
  // Until the profile answers (and for a pref it never set): the device's language as
  // native, the other one to learn — the same pair every other surface opens on.
  const [native, setNative] = useState<string>(() => defaultLanguagePair().native);
  const [learning, setLearning] = useState<string>(() => defaultLanguagePair().learning);
  const [err, setErr] = useState<string | null>(null);
  const langs = targetOptions();

  useEffect(() => {
    let active = true;
    getUserProfile(userId)
      .then((p) => {
        if (!active || !p) return;
        setCreated(p.dateCreated);
        const pair = resolveLanguagePair(p);
        setNative(pair.native);
        setLearning(pair.learning);
      })
      .catch((e) => active && setErr(errorMessage(e)));
    return () => { active = false; };
  }, [userId]);

  const saveNative = async (code: string) => {
    setNative(code);
    try { await updateUserLanguages({ userId, nativeLanguage: code }); }
    catch (e) { setErr(errorMessage(e)); }
  };
  const saveLearning = async (code: string) => {
    setLearning(code);
    try { await updateUserLanguages({ userId, learningLanguage: code }); }
    catch (e) { setErr(errorMessage(e)); }
  };

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
        <label className="profile__label" htmlFor="pf-native">{t("profile.nativeLanguage")}</label>
        <select id="pf-native" className="select select--sm" value={native} onChange={(e) => saveNative(e.target.value)}>
          {langs.map((o) => <option key={o.code} value={o.code}>{o.name}</option>)}
        </select>
      </div>
      <div className="profile__row">
        <label className="profile__label" htmlFor="pf-learning">{t("profile.learningLanguage")}</label>
        <select id="pf-learning" className="select select--sm" value={learning} onChange={(e) => saveLearning(e.target.value)}>
          {langs.map((o) => <option key={o.code} value={o.code}>{o.name}</option>)}
        </select>
      </div>
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
