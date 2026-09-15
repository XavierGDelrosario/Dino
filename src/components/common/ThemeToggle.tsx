// Appearance, as ONE text row in the profile menu: "Theme: System". Click it and it
// cycles System → Light → Dark → System, showing the mode it is in now. The menu stays
// open, so you can watch the screen change and click again.
//
// Three states is few enough that cycling beats choosing — the current one is always
// shown, and any mode is at most two clicks away. Plain text, no icon: a word says
// which mode you're in; a sun/moon glyph had to be decoded.
import { useTheme } from "../../hooks/useTheme";
import { THEME_PREFS, type ThemePref } from "../../services/theme";
import { useI18n, type MessageKey } from "../../i18n";

const LABEL: Record<ThemePref, MessageKey> = {
  system: "theme.system",
  light: "theme.light",
  dark: "theme.dark",
};

export function ThemeToggle() {
  const { t } = useI18n();
  const { pref, setPref } = useTheme();
  const next = THEME_PREFS[(THEME_PREFS.indexOf(pref) + 1) % THEME_PREFS.length];

  return (
    <button
      type="button"
      className="profilemenu__item"
      // The visible text names the current mode; the label adds where a click lands.
      aria-label={t("theme.cycleAria", { mode: t(LABEL[pref]), next: t(LABEL[next]) })}
      onClick={() => setPref(next)}
    >
      {t("theme.item", { mode: t(LABEL[pref]) })}
    </button>
  );
}
