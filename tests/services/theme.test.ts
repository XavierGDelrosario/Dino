// @vitest-environment jsdom
// The theme store: what gets persisted, what gets stamped on <html>, and — the part
// that is easy to break — that an EXPLICIT choice is not silently overwritten when
// the OS flips (the "system" pref is the only one that follows it).
//
// The module keeps its preference in module scope (one global setting, no provider),
// so every test re-imports it with `vi.resetModules()` after seeding storage.
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

type MQL = MediaQueryList & { _fire: () => void };

/** A matchMedia stub for `(prefers-color-scheme: light)` with a settable answer. */
function stubMatchMedia(light: boolean): MQL {
  const listeners: Array<() => void> = [];
  const mql = {
    matches: light,
    media: "(prefers-color-scheme: light)",
    addEventListener: (_: string, fn: () => void) => listeners.push(fn),
    removeEventListener: () => {},
    addListener: (fn: () => void) => listeners.push(fn),
    removeListener: () => {},
    dispatchEvent: () => true,
    onchange: null,
    _fire: () => listeners.forEach((fn) => fn()),
  } as unknown as MQL;
  vi.stubGlobal("matchMedia", () => mql);
  return mql;
}

const load = () => import("@/services/theme");

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("theme preference", () => {
  it("defaults to system, which follows the OS", async () => {
    stubMatchMedia(true);
    const theme = await load();
    expect(theme.getThemePref()).toBe("system");
    expect(theme.resolveTheme("system")).toBe("light");
  });

  it("falls back to dark when the OS says nothing (no matchMedia)", async () => {
    vi.stubGlobal("matchMedia", undefined);
    const theme = await load();
    expect(theme.systemTheme()).toBe("dark");
  });

  it("restores a saved explicit choice", async () => {
    localStorage.setItem("dino.theme", "light");
    stubMatchMedia(false); // OS is dark; the saved choice must win
    const theme = await load();
    expect(theme.getThemePref()).toBe("light");
    expect(theme.getTheme()).toBe("light");
  });

  it("ignores a junk stored value", async () => {
    localStorage.setItem("dino.theme", "sepia");
    stubMatchMedia(false);
    const theme = await load();
    expect(theme.getThemePref()).toBe("system");
  });
});

describe("applying a theme", () => {
  it("stamps <html data-theme>, color-scheme and the browser chrome colour", async () => {
    stubMatchMedia(false);
    const meta = document.createElement("meta");
    meta.setAttribute("name", "theme-color");
    meta.setAttribute("content", "#0f1115");
    document.head.appendChild(meta);

    const theme = await load();
    theme.setThemePref("light");

    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement.style.colorScheme).toBe("light");
    expect(meta.getAttribute("content")).not.toBe("#0f1115");

    theme.setThemePref("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(meta.getAttribute("content")).toBe("#0f1115");
    meta.remove();
  });

  it("persists the choice and notifies subscribers", async () => {
    stubMatchMedia(false);
    const theme = await load();
    const seen: string[] = [];
    const off = theme.subscribeTheme(() => seen.push(theme.getThemePref()));

    theme.setThemePref("light");
    expect(localStorage.getItem("dino.theme")).toBe("light");
    expect(seen).toEqual(["light"]);

    off();
    theme.setThemePref("dark");
    expect(seen).toEqual(["light"]); // unsubscribed
  });
});

describe("following the OS", () => {
  it("repaints on an OS change while the pref is system", async () => {
    const mql = stubMatchMedia(false);
    const theme = await load();
    theme.initTheme();
    expect(document.documentElement.dataset.theme).toBe("dark");

    (mql as unknown as { matches: boolean }).matches = true;
    mql._fire();
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("leaves an explicit choice alone when the OS changes", async () => {
    const mql = stubMatchMedia(false);
    const theme = await load();
    theme.initTheme();
    theme.setThemePref("dark");

    (mql as unknown as { matches: boolean }).matches = true;
    mql._fire();

    expect(theme.getThemePref()).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});
