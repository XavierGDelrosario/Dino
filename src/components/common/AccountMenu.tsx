// Account control (#13). Guest by default (no login wall). When anonymous, a
// panel offers Create-account (upgrades the SAME uid → guest words carry over) or
// Sign-in (an existing account). When permanent, shows the email + Sign out.
// The auth listener in useSession updates the app, so these just call the service.
import { useState } from "react";
import { upgradeToAccount, signIn, signOut, requestPasswordReset } from "../../services/session";
import { errorMessage as message } from "../../lib/errorMessage";
import { checkPassword } from "../../lib/password";
import { useI18n } from "../../i18n";
import "./common.css";

export function AccountMenu({
  isAnonymous,
  email,
}: {
  isAnonymous: boolean;
  email: string | null;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"auth" | "forgot" | "sent">("auth");
  const [emailInput, setEmailInput] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      setOpen(false);
      setEmailInput("");
      setPassword("");
    } catch (e) {
      setErr(message(e));
    } finally {
      setBusy(false);
    }
  };

  if (!isAnonymous) {
    return (
      <div className="account">
        <span className="account__email" title={email ?? ""}>{email}</span>
        <button className="btn btn--sm" disabled={busy} onClick={() => run(() => signOut())}>
          {t("auth.signOut")}
        </button>
      </div>
    );
  }

  const canSubmit = !busy && emailInput.trim() !== "" && password !== "";
  const emailField = (
    <input
      className="input input--sm"
      type="email"
      value={emailInput}
      onChange={(e) => setEmailInput(e.target.value)}
      placeholder={t("auth.emailPlaceholder")}
      aria-label={t("auth.emailPlaceholder")}
      autoComplete="email"
    />
  );

  return (
    <div className="account">
      <button
        className="btn btn--sm"
        onClick={() => { setMode("auth"); setErr(null); setOpen((o) => !o); }}
      >
        {t("auth.signInCreate")}
      </button>
      {open && (
        <div className="account__panel">
          {mode === "auth" && (
            <>
              {emailField}
              <input
                className="input input--sm"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={t("auth.passwordPlaceholder")}
                aria-label={t("auth.passwordPlaceholder")}
                autoComplete="current-password"
              />
              {err && <pre className="review__error">{err}</pre>}
              <div className="account__actions">
                <button
                  className="btn btn--sm"
                  disabled={!canSubmit}
                  onClick={() => {
                    // Enforce the password policy client-side before the round-trip
                    // (the server also rejects weak passwords). Sign-in does NOT
                    // re-validate — existing accounts may predate the policy.
                    const issue = checkPassword(password);
                    if (issue) { setErr(t(issue === "short" ? "auth.pwShort" : "auth.pwWeak")); return; }
                    run(() => upgradeToAccount({ email: emailInput, password }));
                  }}
                >
                  {t("auth.createAccount")}
                </button>
                <button
                  className="btn btn--sm btn--ghost"
                  disabled={!canSubmit}
                  onClick={() => run(() => signIn({ email: emailInput, password }))}
                >
                  {t("auth.signIn")}
                </button>
              </div>
              <button
                className="account__link"
                onClick={() => { setErr(null); setMode("forgot"); }}
              >
                {t("auth.forgot")}
              </button>
              <p className="account__note">{t("auth.upgradeNote")}</p>
            </>
          )}

          {mode === "forgot" && (
            <>
              {emailField}
              {err && <pre className="review__error">{err}</pre>}
              <div className="account__actions">
                <button
                  className="btn btn--sm"
                  disabled={busy || emailInput.trim() === ""}
                  onClick={async () => {
                    // Not run(): keep the panel open and show the "sent" note.
                    setBusy(true);
                    setErr(null);
                    try {
                      await requestPasswordReset(emailInput);
                      setMode("sent");
                    } catch (e) {
                      setErr(message(e));
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {t("auth.sendReset")}
                </button>
                <button className="btn btn--sm btn--ghost" onClick={() => { setErr(null); setMode("auth"); }}>
                  {t("auth.back")}
                </button>
              </div>
            </>
          )}

          {mode === "sent" && <p className="account__note">{t("auth.resetSent")}</p>}
        </div>
      )}
    </div>
  );
}
