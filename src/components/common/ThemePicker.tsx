// Appearance control for the account menu: System · Light · Dark.
//
// A segmented control, not another menu row, because the three options are ONE
// setting with a current value — the row style (a list of actions that close the
// menu) would hide which one is active, and picking a theme is something you do
// while LOOKING at the result, so it deliberately leaves the menu open.
import { useTheme } from "../../hooks/useTheme";
import { THEME_PREFS, type ThemePref } from "../../services/theme";
import { useI18n, type MessageKey } from "../../i18n";

const LABEL: Record<ThemePref, MessageKey> = {
  system: "theme.system",
  light: "theme.light",
  dark: "theme.dark",
};

// Half-lit moon for "follow the system". NOT the obvious desktop-computer glyph:
// U+1F5A5 is a text-default emoji and renders as a hex box in fonts that lack it
// (see tests/components/no-text-default-emoji.test.ts).
const ICON: Record<ThemePref, string> = { system: "🌓", light: "☀️", dark: "🌙" };

export function ThemePicker() {
  const { t } = useI18n();
  const { pref, setPref } = useTheme();

  return (
    <div className="themepicker">
      <span className="themepicker__label" id="themepicker-label">
        {t("theme.label")}
      </span>
      <div className="themepicker__seg" role="radiogroup" aria-labelledby="themepicker-label">
        {THEME_PREFS.map((p) => (
          <button
            key={p}
            type="button"
            role="radio"
            aria-checked={p === pref}
            className={`themepicker__btn${p === pref ? " is-on" : ""}`}
            onClick={() => setPref(p)}
          >
            <span aria-hidden="true">{ICON[p]}</span>
            {t(LABEL[p])}
          </button>
        ))}
      </div>
    </div>
  );
}
