// "The app is back in front of the user" — one subscription over every signal that can
// say so. In a browser that is `visibilitychange` / `focus`. In the iOS app the WebView
// does NOT reliably fire those when the user returns from another app (seen 2026-10-06:
// coming back from Settings after allowing notifications changed nothing on screen),
// so the Capacitor App plugin's `appStateChange` and `resume` are listened to as well.
// Callers re-read whatever may have changed while the app was away. The native plugin
// is imported lazily so the web bundle and unit tests never load it.
import { Capacitor } from "@capacitor/core";

export function onAppResume(fn: () => void): () => void {
  const teardowns: Array<() => void> = [];
  let stopped = false;

  if (typeof document !== "undefined") {
    const onVisible = () => {
      if (document.visibilityState === "visible") fn();
    };
    document.addEventListener("visibilitychange", onVisible);
    teardowns.push(() => document.removeEventListener("visibilitychange", onVisible));
  }
  if (typeof window !== "undefined") {
    window.addEventListener("focus", fn);
    teardowns.push(() => window.removeEventListener("focus", fn));
  }
  if (Capacitor.isNativePlatform()) {
    void import("@capacitor/app")
      .then(({ App }) => {
        if (stopped) return;
        const a = App.addListener("appStateChange", (st) => {
          if (st.isActive) fn();
        });
        const r = App.addListener("resume", () => fn());
        teardowns.push(() => void a.then((h) => h.remove()).catch(() => {}));
        teardowns.push(() => void r.then((h) => h.remove()).catch(() => {}));
      })
      .catch(() => {});
  }
  return () => {
    stopped = true;
    for (const t of teardowns) t();
  };
}
