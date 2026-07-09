// Terms-acceptance takeover (#13 / §10). Shown when a permanent account hasn't
// accepted the current Terms version (terms_version null or behind) — i.e. a
// Google signup that skipped the signup checkbox, or any account after the Terms
// are updated (bump src/lib/terms.ts CURRENT_TERMS_VERSION). Blocks the app until
// they agree; recordTermsAgreement re-stamps the row, then onDone returns to the
// app. The Terms/Privacy links open in a new tab so reading them doesn't dismiss
// the gate. Mirrors the ResetPasswordView takeover pattern.
import { useState } from "react";
import { recordTermsAgreement } from "../../services/session";
import { errorMessage as message } from "../../lib/errorMessage";
import { useI18n } from "../../i18n";
import { ErrorText } from "./ErrorText";
import "./common.css";

export function TermsGateView({ onDone }: { onDone: () => void }) {
  const { t } = useI18n();
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    if (busy || !agreed) return;
    setBusy(true);
    setErr(null);
    try {
      await recordTermsAgreement();
      onDone();
    } catch (e) {
      setErr(message(e));
      setBusy(false);
    }
  };

  return (
    <div className="resetpw">
      <h2 className="resetpw__title">{t("terms.gateTitle")}</h2>
      <label className="authpage__agree">
        <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
        <span>
          {t("auth.agreePre")}
          <a href="/terms" target="_blank" rel="noopener noreferrer" className="account__link">{t("auth.termsLink")}</a>
          {t("auth.agreeMid")}
          <a href="/privacy" target="_blank" rel="noopener noreferrer" className="account__link">{t("auth.privacyLink")}</a>
          {t("auth.agreeSuf")}
        </span>
      </label>
      <ErrorText message={err} />
      <button className="btn" disabled={busy || !agreed} onClick={submit}>
        {t("terms.gateContinue")}
      </button>
    </div>
  );
}
