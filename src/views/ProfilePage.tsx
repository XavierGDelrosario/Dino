// Profile page: identity (email / date created) + the three language settings —
// NATIVE (default translation output), LEARNING (default "I'm learning" + input),
// and APP language (UI localization). Native/learning persist on `users` (follow the
// account); app language is the client-side i18n locale.
import { useEffect, useState } from "react";
import { getUserProfile, updateUserLanguages, signOut } from "../services/session";
import { targetOptions } from "../services/language";
import { errorMessage } from "../lib/errorMessage";
import { useI18n, LOCALES, type Locale } from "../i18n";
import { useRouter, Link } from "../router";
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
  const { navigate } = useRouter();
  const [created, setCreated] = useState<string | null>(null);
  const [native, setNative] = useState<string>("EN");
  const [learning, setLearning] = useState<string>("JA");
  const [err, setErr] = useState<string | null>(null);
  const langs = targetOptions();

  useEffect(() => {
    let active = true;
    getUserProfile(userId)
      .then((p) => {
        if (!active || !p) return;
        setCreated(p.dateCreated);
        if (p.nativeLanguage) setNative(p.nativeLanguage);
        if (p.learningLanguage) setLearning(p.learningLanguage);
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

      {err && <pre className="review__error">{err}</pre>}

      <div className="profile__actions">
        {isAnonymous ? (
          <Link to="/signup" className="btn btn--sm">{t("auth.signInCreate")}</Link>
        ) : (
          <button className="btn btn--sm" onClick={() => signOut().then(() => navigate("/"))}>
            {t("auth.signOut")}
          </button>
        )}
        <Link to="/" className="account__link">{t("profile.back")}</Link>
      </div>
    </section>
  );
}
