// Person-icon dropdown (top-right): profile link + sign-in (guest) / sign-out
// (account). The forms live on their own pages now (AuthPage); this just navigates.
//
// ORDER: email · Profile · Theme · sign-in/sign-out. This is the ACCOUNT menu, so the
// account's own destination leads and the theme is a setting that merely lives here.
// For a GUEST, Profile is absent (there is no account behind it), so the theme row rises
// to the top on its own — a guest has no profile page but still needs the theme.
import { signOut } from "../../services/session";
import { useI18n } from "../../i18n";
import { useRouter, Link } from "../../router";
import { PopoverMenu } from "./PopoverMenu";
import { ThemeToggle } from "./ThemeToggle";

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
    <PopoverMenu icon="👤" ariaLabel={t("profile.menuAria")} open={open} onToggle={onToggle}>
      {!isAnonymous && email && <div className="profilemenu__email ellipsis">{email}</div>}
      {/* Guests have no real account → no profile; just the sign-in/create path.
          It sits ABOVE the theme row: this is the ACCOUNT menu, so the account's own
          destination leads, and the theme is a setting that happens to live here. */}
      {!isAnonymous && (
        <Link to="/profile" className="profilemenu__item" onClick={close}>{t("profile.profileLink")}</Link>
      )}
      <ThemeToggle />
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
    </PopoverMenu>
  );
}
