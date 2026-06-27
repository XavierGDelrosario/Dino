// Sign-in / Create-account page (separate routes). Reuses the session service +
// the password policy. On success → home. "Create account" upgrades the current
// guest in place (keeps their words); "Sign in" switches to an existing account.
import { useState } from "react";
import { upgradeToAccount, signIn, requestPasswordReset, linkGoogle, signInWithGoogle, recordTermsAgreement } from "../services/session";
import { onOAuthBrowserDismissed } from "../services/nativeAuth";
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
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [forgot, setForgot] = useState(false);
  const [sent, setSent] = useState(false);
  const [confirmSent, setConfirmSent] = useState(false);
  const [agreed, setAgreed] = useState(false);

  // Signup requires accepting the Terms/Privacy; sign-in doesn't.
  const needsAgreement = mode === "signup" && !agreed;

  const submit = async () => {
    if (busy || !email.trim() || password === "" || needsAgreement) return;
    if (mode === "signup") {
      const issue = checkPassword(password);
      if (issue) { setErr(t(issue === "short" ? "auth.pwShort" : "auth.pwWeak")); return; }
      if (password !== confirm) { setErr(t("auth.pwMismatch")); return; }
    }
    setBusy(true);
    setErr(null);
    try {
      if (mode === "signup") {
        // Stamp acceptance on the guest row FIRST (same uid survives the upgrade), so
        // the post-login terms-gate check can't race ahead of the stamp and wrongly
        // re-prompt a user who just ticked the box.
        await recordTermsAgreement();
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

  // Google redirects away on success (onAuthStateChange resumes on return). On
  // native it opens an in-app OAuth sheet and returns immediately; the login
  // finishes asynchronously via the deep-link handler. If the user instead CANCELS
  // that sheet, no callback fires — so watch for the sheet closing and re-enable the
  // form (otherwise `busy` stays stuck and every button is disabled). No-op on web.
  const google = async () => {
    if (needsAgreement) return;
    setBusy(true);
    setErr(null);
    const stopWatch = await onOAuthBrowserDismissed(() => setBusy(false));
    try {
      // Signup links Google to the SAME uid; stamp the agreement before redirecting.
      if (mode === "signup") await recordTermsAgreement();
      await (mode === "signup" ? linkGoogle() : signInWithGoogle());
    } catch (e) {
      stopWatch();
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
      {mode === "signup" && (
        <input className="input" type="password" value={confirm} placeholder={t("auth.confirmPasswordPlaceholder")}
          aria-label={t("auth.confirmPasswordPlaceholder")} autoComplete="new-password"
          onChange={(e) => setConfirm(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()} />
      )}
      {mode === "signup" && (
        <label className="authpage__agree">
          <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
          <span>
            {t("auth.agreePre")}
            <Link to="/terms" className="account__link">{t("auth.termsLink")}</Link>
            {t("auth.agreeMid")}
            <Link to="/privacy" className="account__link">{t("auth.privacyLink")}</Link>
            {t("auth.agreeSuf")}
          </span>
        </label>
      )}
      {err && <pre className="review__error">{err}</pre>}
      <button className="btn"
        disabled={busy || !email.trim() || password === "" || needsAgreement || (mode === "signup" && confirm === "")}
        onClick={submit}>
        {mode === "signup" ? t("auth.createAccount") : t("auth.signIn")}
      </button>

      <button className="btn btn--ghost" disabled={busy || needsAgreement} onClick={google}>
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
