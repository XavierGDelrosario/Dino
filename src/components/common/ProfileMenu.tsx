// Person-icon dropdown (top-right). Profile link + sign-in (guest) / sign-out
// (account). The forms live on their own pages now (AuthPage); this just navigates.
import { signOut } from "../../services/session";
import { useI18n } from "../../i18n";
import { useRouter, Link } from "../../router";
import "./common.css";

// Controlled by App so it and LanguageMenu are mutually exclusive (opening one
// closes the other).
export function ProfileMenu({
  isAnonymous,
  email,
  open,
  onToggle,
  onClose,
}: {
  isAnonymous: boolean;
  email: string | null;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const { navigate } = useRouter();
  const close = onClose;

  return (
    <div className="profilemenu">
      <button
        className="profilemenu__btn"
        aria-label={t("profile.menuAria")}
        aria-haspopup="menu"
        onClick={onToggle}
      >
        <span aria-hidden="true">👤</span>
      </button>
      {open && (
        <div className="profilemenu__panel" role="menu">
          {!isAnonymous && email && <div className="profilemenu__email">{email}</div>}
          {/* Guests have no real account → no profile; just the sign-in/create path. */}
          {!isAnonymous && (
            <Link to="/profile" className="profilemenu__item" onClick={close}>{t("profile.profileLink")}</Link>
          )}
          {isAnonymous ? (
            <Link to="/signin" className="profilemenu__item" onClick={close}>{t("auth.signInCreate")}</Link>
          ) : (
            <button
              className="profilemenu__item"
              onClick={() => { close(); signOut().then(() => navigate("/")); }}
            >
              {t("auth.signOut")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
