// Set-a-new-password screen (#13). Shown when the user followed a reset link and
// is in a PASSWORD_RECOVERY session (useSession.recovering). On success they're left
// signed in to that account; onDone clears the recovery flag → back to the app.
import { useState } from "react";
import { setNewPassword } from "../../services/session";
import { errorMessage as message } from "../../lib/errorMessage";
import { checkPassword } from "../../lib/password";
import { useI18n } from "../../i18n";
import "./common.css";

export function ResetPasswordView({ onDone }: { onDone: () => void }) {
  const { t } = useI18n();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    if (busy || password === "") return;
    const issue = checkPassword(password);
    if (issue) { setErr(t(issue === "short" ? "auth.pwShort" : "auth.pwWeak")); return; }
    if (password !== confirm) { setErr(t("auth.pwMismatch")); return; }
    setBusy(true);
    setErr(null);
    try {
      await setNewPassword(password);
      onDone(); // signed in to the account now → back to the app
    } catch (e) {
      setErr(message(e));
      setBusy(false);
    }
  };

  return (
    <div className="resetpw">
      <h2 className="resetpw__title">{t("auth.resetTitle")}</h2>
      <input
        className="input"
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder={t("auth.newPasswordPlaceholder")}
        aria-label={t("auth.newPasswordPlaceholder")}
        autoComplete="new-password"
        autoFocus
      />
      <input
        className="input"
        type="password"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submit()}
        placeholder={t("auth.confirmPasswordPlaceholder")}
        aria-label={t("auth.confirmPasswordPlaceholder")}
        autoComplete="new-password"
      />
      {err && <pre className="review__error">{err}</pre>}
      <button className="btn" disabled={busy || password === "" || confirm === ""} onClick={submit}>
        {t("auth.updatePassword")}
      </button>
    </div>
  );
}
