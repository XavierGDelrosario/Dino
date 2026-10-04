// Sign-in / Create-account page (separate routes). Reuses the session service +
// the password policy. On success → home. "Create account" upgrades the current
// guest in place (keeps their words); "Sign in" switches to an existing account and
// merges the guest's words into it (services/session claimGuestMerge).
//
// COLLISIONS — one email, several ways in. Sign-up on a taken email, or a password
// sign-in on an OAuth-only account, names how that account actually signs in
// (getSignInMethods). A sign-up that LINKS a Google/Apple account which is already a
// DINO user is answered by signing in to it instead — the guest's words follow.
import { useEffect, useState } from "react";
import {
  upgradeToAccount,
  signIn,
  requestPasswordReset,
  linkGoogle,
  signInWithGoogle,
  linkApple,
  signInWithApple,
  signInWithProvider,
  recordTermsAgreement,
  collisionKind,
  getSignInMethods,
  type SignInMethod,
} from "../services/session";
import { onOAuthBrowserDismissed } from "../services/nativeAuth";
import { onOAuthError, takeOAuthError, type OAuthReturnError } from "../services/oauthReturn";
import { googleIdTokenEnabled, startGoogleSignIn, takeGoogleFailure } from "../services/googleIdentity";
import { errorMessage } from "../lib/errorMessage";
import { formatMethods, oauthErrorCopy, PROVIDER } from "../lib/authCopy";
import { checkPassword } from "../lib/password";
import { useI18n } from "../i18n";
import { ErrorText } from "../components/common/ErrorText";
import { InputField } from "../components/common/InputField";
import { useRouter, Link } from "../router";
import "../components/common/common.css";

const APPLE_SIGNIN_ENABLED = import.meta.env.VITE_APPLE_SIGNIN === "1";

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

  const [note, setNote] = useState<string | null>(null);

  // Signup requires accepting the Terms/Privacy; sign-in doesn't.
  const needsAgreement = mode === "signup" && !agreed;

  // A failed OAuth round-trip comes back here: on web as a pending error read once
  // on mount (the page load IS the return), on native as an event while this page
  // sits under the in-app browser.
  useEffect(() => {
    const handle = (e: OAuthReturnError) => {
      const provider = e.intent?.provider;
      if (e.code === "identity_already_exists" && e.intent?.mode === "signup" && !e.intent.fallback && provider) {
        // The provider account is already a DINO user, so linking it to this guest
        // can't work — sign in to it instead; the guest's words are merged across.
        setErr(null);
        setNote(t("auth.linkTaken", { provider: PROVIDER[provider] }));
        setBusy(true);
        // Native: cancelling this second sheet fires no callback, so re-enable on close.
        void onOAuthBrowserDismissed(() => { setBusy(false); setNote(null); }).then((stopWatch) =>
          signInWithProvider(provider, { fallback: true }).catch((x) => {
            stopWatch();
            setNote(null);
            setErr(errorMessage(x));
            setBusy(false);
          }),
        );
        return;
      }
      setBusy(false);
      setNote(null);
      setErr(oauthErrorCopy(t, e));
    };
    const pending = takeOAuthError();
    if (pending) handle(pending);
    return onOAuthError(handle);
  }, [t]);

  /** Explain a collision by naming how the existing account signs in; anything that
   *  isn't a collision keeps the generic message. */
  const explain = async (e: unknown): Promise<string> => {
    const kind = collisionKind(e);
    if (!kind) return errorMessage(e);
    const methods = await getSignInMethods(email);
    if (kind === "account_exists") {
      return methods.length
        ? t("auth.existsWith", { methods: formatMethods(t, methods) })
        : t("auth.existsGeneric");
    }
    // A failed password sign-in on an account with no password at all.
    if (methods.length && !methods.includes("email")) {
      return t("auth.usesOther", { methods: formatMethods(t, methods) });
    }
    return t("auth.badCredentials");
  };

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
      setErr(await explain(e));
    } finally {
      setBusy(false);
    }
  };

  // Google redirects away on success (onAuthStateChange resumes on return). On
  // native it opens an in-app OAuth sheet and returns immediately; the login
  // finishes asynchronously via the deep-link handler. If the user instead CANCELS
  // that sheet, no callback fires — so watch for the sheet closing and re-enable the
  // form (otherwise `busy` stays stuck and every button is disabled). No-op on web.
  const oauth = (link: () => Promise<void>, signInWith: () => Promise<void>) => async () => {
    if (needsAgreement) return;
    setBusy(true);
    setErr(null);
    const stopWatch = await onOAuthBrowserDismissed(() => setBusy(false));
    try {
      // Signup LINKS to the same uid, so the guest's words carry over; stamp the
      // agreement before redirecting, since the redirect leaves this page.
      if (mode === "signup") await recordTermsAgreement();
      await (mode === "signup" ? link() : signInWith());
    } catch (e) {
      stopWatch();
      setErr(errorMessage(e));
      setBusy(false);
    }
  };
  // WEB with a Google client id: go to Google ourselves and come back to this origin
  // with an ID token (services/googleIdentity), so Google never shows Supabase's
  // domain. Otherwise (native, or no client id) the Supabase redirect flow.
  const google = googleIdTokenEnabled()
    ? async () => {
        if (needsAgreement) return;
        setBusy(true);
        setErr(null);
        try {
          // Stamp the agreement before leaving: the page unloads, and a sign-up that
          // returns already linked must not be re-prompted by the terms gate.
          if (mode === "signup") await recordTermsAgreement();
          await startGoogleSignIn(mode); // navigates away; `busy` holds until it does
        } catch (e) {
          setErr(errorMessage(e));
          setBusy(false);
        }
      }
    : oauth(linkGoogle, signInWithGoogle);

  // A Google return is finished by the app shell behind its splash (App.tsx); only a
  // REFUSED one lands here, with its reason.
  useEffect(() => {
    const failed = takeGoogleFailure();
    if (failed) {
      setErr(
        failed.methods.length
          ? t("auth.existsWith", { methods: formatMethods(t, failed.methods as SignInMethod[]) })
          : oauthErrorCopy(t, {
              code: failed.code,
              description: null,
              intent: { mode, provider: "google", at: Date.now() },
            }),
      );
    }
    // Leaving for Google sets `busy`; "Back" can restore this page from the browser's
    // back/forward cache with it still set, and every button disabled.
    const restored = (e: PageTransitionEvent) => { if (e.persisted) setBusy(false); };
    window.addEventListener("pageshow", restored);
    return () => window.removeEventListener("pageshow", restored);
  }, [t, mode]);
  const apple = oauth(linkApple, signInWithApple);

  const sendReset = async () => {
    if (busy || !email.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      // A reset would try to give a Google/Apple account a password — which the
      // one-method rule refuses anyway — so send them to their method instead.
      const methods = await getSignInMethods(email);
      if (methods.length && !methods.includes("email")) {
        setErr(t("auth.usesOther", { methods: formatMethods(t, methods) }));
        return;
      }
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
            <InputField type="email" value={email} onChange={setEmail}
              placeholder={t("auth.emailPlaceholder")} ariaLabel={t("auth.emailPlaceholder")} autoComplete="email" />
            <ErrorText message={err} />
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
      {/* Way out, at the TOP — the rest of the app puts "back" last, but this page had
          none at all, and on native there is no browser chrome to fall back on: opening
          Sign in and changing your mind left you stuck on the form. It also can't go at
          the bottom here, where three links already sit (forgot · switch mode · the
          upgrade note) — a fourth would read as a fourth choice rather than the exit.
          Signing in is optional in DINO (a guest is a real account), so leaving must be
          as reachable as continuing. */}
      <Link to="/" className="account__link authpage__back">{t("profile.back")}</Link>
      <h2 className="authpage__title">{mode === "signup" ? t("auth.signUpTitle") : t("auth.signInTitle")}</h2>
      <InputField type="email" value={email} onChange={setEmail}
        placeholder={t("auth.emailPlaceholder")} ariaLabel={t("auth.emailPlaceholder")} autoComplete="email" />
      <InputField type="password" value={password} onChange={setPassword}
        placeholder={t("auth.passwordPlaceholder")} ariaLabel={t("auth.passwordPlaceholder")}
        autoComplete={mode === "signup" ? "new-password" : "current-password"}
        onEnter={submit} />
      {mode === "signup" && (
        <InputField type="password" value={confirm} onChange={setConfirm}
          placeholder={t("auth.confirmPasswordPlaceholder")} ariaLabel={t("auth.confirmPasswordPlaceholder")}
          autoComplete="new-password" onEnter={submit} />
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
      {note && <p className="review__msg">{note}</p>}
      <ErrorText message={err} />
      <button className="btn"
        disabled={busy || !email.trim() || password === "" || needsAgreement || (mode === "signup" && confirm === "")}
        onClick={submit}>
        {mode === "signup" ? t("auth.createAccount") : t("auth.signIn")}
      </button>

      <button className="btn btn--ghost" disabled={busy || needsAgreement} onClick={google}>
        {t("auth.google")}
      </button>

      {/* Sign in with Apple is not optional on iOS: the App Store requires it
          wherever another third-party login is offered. It is shown only once the
          project's Apple provider is configured (VITE_APPLE_SIGNIN=1) — before that the
          button led off the site to a raw provider-not-enabled error. */}
      {APPLE_SIGNIN_ENABLED && (
        <button className="btn btn--ghost" disabled={busy || needsAgreement} onClick={apple}>
          {t("auth.apple")}
        </button>
      )}

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
