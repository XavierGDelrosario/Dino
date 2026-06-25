// Globe-icon dropdown (top-right, left of the profile icon) for choosing the APP
// UI language (i18n locale) — distinct from the translation source/target. Always
// available (localization works before any session). Reuses the ProfileMenu
// button/panel styles; positioned left of it via the .langmenu class.
import { useI18n, LOCALES, type Locale } from "../../i18n";
import "./common.css";

// Controlled by App so it and ProfileMenu are mutually exclusive (opening one
// closes the other).
export function LanguageMenu({
  open,
  onToggle,
  onClose,
}: {
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
}) {
  const { t, locale, setLocale } = useI18n();

  return (
    <div className="profilemenu langmenu">
      <button
        className="profilemenu__btn"
        aria-label={t("ui.language")}
        aria-haspopup="menu"
        onClick={onToggle}
      >
        <span aria-hidden="true">🌐</span>
      </button>
      {open && (
        <div className="profilemenu__panel" role="menu">
          {LOCALES.map((l) => (
            <button
              key={l.code}
              className="profilemenu__item"
              aria-current={l.code === locale}
              onClick={() => { setLocale(l.code as Locale); onClose(); }}
            >
              {l.label}{l.code === locale ? " ✓" : ""}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
