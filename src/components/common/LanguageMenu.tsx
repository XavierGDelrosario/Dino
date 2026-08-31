// Globe-icon dropdown (top-right) for choosing the APP UI language (i18n locale) —
// distinct from the translation source/target. Always available (localization works
// before any session). Reuses the ProfileMenu button/panel styles; the top bar lays
// the three controls out as a flex row (.app__menus), so this positions nothing.
import { useI18n, LOCALES, type Locale } from "../../i18n";
import { PopoverMenu } from "./PopoverMenu";

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
    <PopoverMenu icon="🌐" ariaLabel={t("ui.language")} open={open} onToggle={onToggle}>
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
    </PopoverMenu>
  );
}
