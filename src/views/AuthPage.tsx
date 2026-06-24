// Sign-in / Create-account page (separate routes). Reuses the session service +
// the password policy. On success → home. "Create account" upgrades the current
// guest in place (keeps their words); "Sign in" switches to an existing account.
import { useState } from "react";
import { upgradeToAccount, signIn, requestPasswordReset, linkGoogle, signInWithGoogle } from "../services/session";
import { errorMessage } from "../lib/errorMessage";
import { checkPassword } from "../lib/password";
import { useI18n } from "../i18n";
import { useRouter, Link } from "../router";
import "../components/common/common.css";

export function AuthPage({ mode }: { mode: "signin" | "signup" }) {
  const { t } = useI18n();
  const { navigate } = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [forgot, setForgot] = useState(false);
  const [sent, setSent] = useState(false);
  const [confirmSent, setConfirmSent] = useState(false);

  const submit = async () => {
    if (busy || !email.trim() || password === "") return;
    if (mode === "signup") {
      const issue = checkPassword(password);
      if (issue) { setErr(t(issue === "short" ? "auth.pwShort" : "auth.pwWeak")); return; }
    }
    setBusy(true);
    setErr(null);
    try {
      if (mode === "signup") {
        const { emailPending } = await upgradeToAccount({ email, password });
        if (emailPending) { setConfirmSent(true); return; } // prod: confirm via email first
      } else {
        await signIn({ email, password });
      }
      navigate("/");
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  // Google redirects away on success (onAuthStateChange resumes on return).
  const google = async () => {
    setBusy(true);
    setErr(null);
    try {
      await (mode === "signup" ? linkGoogle() : signInWithGoogle());
    } catch (e) {
      setErr(errorMessage(e));
      setBusy(false);
    }
  };

  const sendReset = async () => {
    if (busy || !email.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      await requestPasswordReset(email);
      setSent(true);
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (forgot) {
    return (
      <section className="authpage">
        <h2 className="authpage__title">{t("auth.forgot")}</h2>
        {sent ? (
          <p className="review__msg">{t("auth.resetSent")}</p>
        ) : (
          <>
            <input className="input" type="email" value={email} placeholder={t("auth.emailPlaceholder")}
              aria-label={t("auth.emailPlaceholder")} autoComplete="email"
              onChange={(e) => setEmail(e.target.value)} />
            {err && <pre className="review__error">{err}</pre>}
            <button className="btn" disabled={busy || !email.trim()} onClick={sendReset}>
              {t("auth.sendReset")}
            </button>
          </>
        )}
        <button className="account__link" onClick={() => { setForgot(false); setSent(false); setErr(null); }}>
          {t("auth.back")}
        </button>
      </section>
    );
  }

  if (confirmSent) {
    return (
      <section className="authpage">
        <h2 className="authpage__title">{t("auth.signUpTitle")}</h2>
        <p className="review__msg">{t("auth.confirmEmail")}</p>
        <Link to="/" className="account__link">{t("profile.back")}</Link>
      </section>
    );
  }

  return (
    <section className="authpage">
      <h2 className="authpage__title">{mode === "signup" ? t("auth.signUpTitle") : t("auth.signInTitle")}</h2>
      <input className="input" type="email" value={email} placeholder={t("auth.emailPlaceholder")}
        aria-label={t("auth.emailPlaceholder")} autoComplete="email"
        onChange={(e) => setEmail(e.target.value)} />
      <input className="input" type="password" value={password} placeholder={t("auth.passwordPlaceholder")}
        aria-label={t("auth.passwordPlaceholder")}
        autoComplete={mode === "signup" ? "new-password" : "current-password"}
        onChange={(e) => setPassword(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submit()} />
      {err && <pre className="review__error">{err}</pre>}
      <button className="btn" disabled={busy || !email.trim() || password === ""} onClick={submit}>
        {mode === "signup" ? t("auth.createAccount") : t("auth.signIn")}
      </button>

      <button className="btn btn--ghost" disabled={busy} onClick={google}>
        {t("auth.google")}
      </button>

      {mode === "signin" && (
        <button className="account__link" onClick={() => { setForgot(true); setErr(null); }}>
          {t("auth.forgot")}
        </button>
      )}
      <p className="authpage__alt">
        {mode === "signup" ? (
          <Link to="/signin" className="account__link">{t("auth.toSignIn")}</Link>
        ) : (
          <Link to="/signup" className="account__link">{t("auth.toSignUp")}</Link>
        )}
      </p>
      {mode === "signup" && <p className="account__note">{t("auth.upgradeNote")}</p>}
    </section>
  );
}
