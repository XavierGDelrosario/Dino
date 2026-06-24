// Person-icon dropdown (top-right). Profile link + sign-in (guest) / sign-out
// (account). The forms live on their own pages now (AuthPage); this just navigates.
import { useState } from "react";
import { signOut } from "../../services/session";
import { useI18n } from "../../i18n";
import { useRouter, Link } from "../../router";
import "./common.css";

export function ProfileMenu({ isAnonymous, email }: { isAnonymous: boolean; email: string | null }) {
  const { t } = useI18n();
  const { navigate } = useRouter();
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

  return (
    <div className="profilemenu">
      <button
        className="profilemenu__btn"
        aria-label={t("profile.menuAria")}
        aria-haspopup="menu"
        onClick={() => setOpen((o) => !o)}
      >
        <span aria-hidden="true">👤</span>
      </button>
      {open && (
        <div className="profilemenu__panel" role="menu">
          {!isAnonymous && email && <div className="profilemenu__email">{email}</div>}
          <Link to="/profile" className="profilemenu__item" onClick={close}>{t("profile.profileLink")}</Link>
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
