// Set-a-new-password screen (#13). Shown when the user followed a reset link and
// is in a PASSWORD_RECOVERY session (useSession.recovering). On success they're left
// signed in to that account; onDone clears the recovery flag → back to the app.
import { useState } from "react";
import { setNewPassword } from "../../services/session";
import { errorMessage as message } from "../../lib/errorMessage";
import { useI18n } from "../../i18n";
import "./common.css";

export function ResetPasswordView({ onDone }: { onDone: () => void }) {
  const { t } = useI18n();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    if (busy || password === "") return;
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
      {err && <pre className="review__error">{err}</pre>}
      <button className="btn" disabled={busy || password === ""} onClick={submit}>
        {t("auth.updatePassword")}
      </button>
    </div>
  );
}
