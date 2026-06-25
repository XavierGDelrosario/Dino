// Globe-icon dropdown (top-right, left of the profile icon) for choosing the APP
// UI language (i18n locale) — distinct from the translation source/target. Always
// available (localization works before any session). Reuses the ProfileMenu
// button/panel styles; positioned left of it via the .langmenu class.
import { useState } from "react";
import { useI18n, LOCALES, type Locale } from "../../i18n";
import "./common.css";

export function LanguageMenu() {
  const { t, locale, setLocale } = useI18n();
  const [open, setOpen] = useState(false);

  return (
    <div className="profilemenu langmenu">
      <button
        className="profilemenu__btn"
        aria-label={t("ui.language")}
        aria-haspopup="menu"
        onClick={() => setOpen((o) => !o)}
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
              onClick={() => { setLocale(l.code as Locale); setOpen(false); }}
            >
              {l.label}{l.code === locale ? " ✓" : ""}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
