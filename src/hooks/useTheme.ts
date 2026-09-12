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
  // TWO subscriptions to the one store, deliberately — `theme` is NOT derivable from
  // `pref` here. When the OS flips at sunset while the pref is "system", the store
  // notifies but `getThemePref` still returns "system": an unchanged snapshot, which
  // useSyncExternalStore bails out on. Deriving `resolveTheme(pref)` would therefore
  // skip the re-render, and the handwriting pad (which repaints canvas ink on `theme`)
  // would keep the old ink. The second snapshot is what actually changes.
  const pref = useSyncExternalStore(subscribeTheme, getThemePref, getThemePref);
  const theme = useSyncExternalStore(subscribeTheme, getTheme, getTheme);
  return { pref, theme, setPref: setThemePref };
}
