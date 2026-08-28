// React view of the theme store (services/theme.ts). Subscribes to the module
// store rather than owning state, so the top-bar picker and anything that needs
// to REPAINT on a theme change (the handwriting pad draws its ink into a canvas,
// which no stylesheet can restyle after the fact) always agree.
import { useSyncExternalStore } from "react";
import {
  getTheme,
  getThemePref,
  initTheme,
  setThemePref,
  subscribeTheme,
  type Theme,
  type ThemePref,
} from "../services/theme";

initTheme();

export function useTheme(): {
  /** What the user picked ("system" included) — for the picker's checkmark. */
  pref: ThemePref;
  /** What is actually painted right now — for anything that must match it. */
  theme: Theme;
  setPref: (p: ThemePref) => void;
} {
  const pref = useSyncExternalStore(subscribeTheme, getThemePref, getThemePref);
  const theme = useSyncExternalStore(subscribeTheme, getTheme, getTheme);
  return { pref, theme, setPref: setThemePref };
}
