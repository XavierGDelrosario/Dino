// Appearance, as ONE button in the top bar beside the language globe: click it and it
// cycles System → Light → Dark → System, showing the mode it is in now.
//
// It was a three-option segmented control inside the profile menu. Two problems with
// that: a guest and an account both need it, but it sat behind a person icon that
// reads as account business; and picking a theme is something you do while LOOKING at
// the screen you want changed, which is a poor fit for a control you have to open a
// menu to reach. Three states is few enough that cycling is faster than choosing —
// the current one is always on screen, and any mode is at most two clicks away.
//
// The trigger deliberately reuses `.profilemenu__btn`, the shared top-bar icon button
// (globe · appearance · person), so the three read as one row of controls.
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

export function ThemeToggle() {
  const { t } = useI18n();
  const { pref, setPref } = useTheme();
  const next = THEME_PREFS[(THEME_PREFS.indexOf(pref) + 1) % THEME_PREFS.length];
  // The icon alone can't say what it does, so the label carries BOTH the current mode
  // and the one a click lands on — otherwise a cycling control is a guess.
  const label = t("theme.cycleAria", { mode: t(LABEL[pref]), next: t(LABEL[next]) });

  return (
    <button
      type="button"
      className="profilemenu__btn"
      aria-label={label}
      title={label}
      onClick={() => setPref(next)}
    >
      <span aria-hidden="true">{ICON[pref]}</span>
    </button>
  );
}
