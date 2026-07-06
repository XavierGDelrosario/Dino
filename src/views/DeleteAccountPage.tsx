// Standalone account-deletion confirmation page (/delete-account), reached from
// the Profile footer. A separate page (not an inline confirm) so the irreversible
// action gets its own deliberate step. On confirm: deleteAccount() erases the
// user's data + auth identity, signs out → fresh guest, then back to the app.
import { useState } from "react";
import { deleteAccount } from "../services/session";
import { errorMessage } from "../lib/errorMessage";
import { useI18n } from "../i18n";
import { ErrorText } from "../components/common/ErrorText";
import { useRouter, Link } from "../router";
import "../components/common/common.css";

export function DeleteAccountPage() {
  const { t } = useI18n();
  const { navigate } = useRouter();
  const [deleting, setDeleting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const onDelete = async () => {
    if (deleting) return;
    setDeleting(true);
    setErr(null);
    try {
      await deleteAccount();
      navigate("/");
    } catch (e) {
      setErr(errorMessage(e));
      setDeleting(false);
    }
  };

  return (
    <section className="authpage">
      <h2 className="authpage__title">{t("profile.deleteAccount")}</h2>
      <p className="profile__dangerwarn">{t("profile.deleteConfirm")}</p>
      <ErrorText message={err} />
      <button className="btn btn--danger" disabled={deleting} onClick={onDelete}>
        {deleting ? "…" : t("profile.deleteYes")}
      </button>
      <Link to="/profile" className="account__link">{t("profile.deleteCancel")}</Link>
    </section>
  );
}
