// =========================================================
// App theme (dark / light) — the ONE place the choice is stored, resolved and
// applied. Kept in services/ (not a hook) because it has to run BEFORE React:
// index.html carries a tiny inline copy of `resolve` that stamps
// <html data-theme> on first paint, so a light-mode user never sees a flash of
// the dark palette. If you change the storage key or the resolution rule here,
// change that script too — they are the same decision in two runtimes.
//
// Three prefs, not two. "system" is the DEFAULT and follows the OS, so the app
// matches whatever the rest of the device is doing; "light"/"dark" are an
// explicit override that survives a reload. The DOM only ever sees the RESOLVED
// value ("light" | "dark"), so CSS needs a single attribute selector and never
// has to reason about "system".
//
// The palette itself lives in components/common/common.css: :root is the dark
// (brand) set, :root[data-theme="light"] overrides the tokens. Everything else
// in the app paints from those tokens.
// =========================================================

/** What the user picked. */
export type ThemePref = "system" | "light" | "dark";
/** What the UI actually paints — "system" resolved against the OS. */
export type Theme = "light" | "dark";

export const THEME_PREFS: readonly ThemePref[] = ["system", "light", "dark"] as const;

const STORAGE_KEY = "dino.theme";

/** Browser-chrome colour per theme (the <meta name="theme-color"> in index.html). */
const THEME_COLOR: Record<Theme, string> = { dark: "#0f1115", light: "#f6f7fb" };

const isPref = (v: unknown): v is ThemePref =>
  v === "system" || v === "light" || v === "dark";

/** Saved choice → "system". Storage can throw (private mode); never let it break boot. */
export function readThemePref(): ThemePref {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (isPref(saved)) return saved;
  } catch {
    /* localStorage unavailable — fall through to the default */
  }
  return "system";
}

/**
 * The OS setting. Queried as `prefers-color-scheme: light` rather than `dark` on
 * purpose: DINO is dark-first, so anything that isn't an explicit light
 * preference (including a browser with no matchMedia) stays on the brand palette.
 */
export function systemTheme(): Theme {
  if (typeof window === "undefined" || !window.matchMedia) return "dark";
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function resolveTheme(pref: ThemePref): Theme {
  return pref === "system" ? systemTheme() : pref;
}

/**
 * Stamp the resolved theme on <html>. `color-scheme` comes along so the browser's
 * OWN widgets — form controls, scrollbars, the caret — flip with us; without it a
 * light page keeps dark native scrollbars.
 */
export function applyTheme(theme: Theme): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", THEME_COLOR[theme]);
}

// ---- tiny store ---------------------------------------------------------
// A module-level store rather than React state: the preference is global, the OS
// listener must run whether or not the menu that changes it is mounted, and
// useSyncExternalStore then gives every consumer the same value with no provider.

let pref: ThemePref = readThemePref();
const listeners = new Set<() => void>();
let watching = false;

const notify = () => listeners.forEach((fn) => fn());

export function getThemePref(): ThemePref {
  return pref;
}

/** The resolved theme currently painted. */
export function getTheme(): Theme {
  return resolveTheme(pref);
}

export function setThemePref(next: ThemePref): void {
  pref = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* non-persistent is still usable for this session */
  }
  applyTheme(resolveTheme(next));
  notify();
}

export function subscribeTheme(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Apply the stored choice and keep following the OS while the pref is "system".
 * Idempotent — safe to call from module scope and from StrictMode's double mount.
 */
export function initTheme(): void {
  applyTheme(resolveTheme(pref));
  if (watching || typeof window === "undefined" || !window.matchMedia) return;
  watching = true;
  const mq = window.matchMedia("(prefers-color-scheme: light)");
  const onChange = () => {
    // Only "system" tracks the OS; an explicit choice must not be overwritten
    // when the user's laptop flips at sunset.
    if (pref !== "system") return;
    applyTheme(systemTheme());
    notify();
  };
  // addEventListener("change") is the modern API; Safari < 14 only has addListener.
  if (mq.addEventListener) mq.addEventListener("change", onChange);
  else mq.addListener(onChange);
}
