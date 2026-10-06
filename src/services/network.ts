// What kind of connection the device is on — asked before anything optional is
// downloaded, so the app never spends a learner's mobile data on a convenience.
//
// Native only in practice: WebKit has no `navigator.connection`, so the answer comes
// from the Capacitor Network plugin. Anything it can't confirm as Wi-Fi is NOT Wi-Fi —
// the cost of being wrong that way round is a download that waits, never a bill.

import { Capacitor } from "@capacitor/core";
import { Network } from "@capacitor/network";

const available = (): boolean =>
  Capacitor.isNativePlatform() && Capacitor.isPluginAvailable("Network");

/** True only when the device is confirmed to be on Wi-Fi. */
export async function isOnWifi(): Promise<boolean> {
  if (!available()) return false;
  try {
    return (await Network.getStatus()).connectionType === "wifi";
  } catch {
    return false;
  }
}

/** Call `fn` each time the device joins Wi-Fi. Returns a teardown. */
export function onWifiConnected(fn: () => void): () => void {
  if (!available()) return () => {};
  const handle = Network.addListener("networkStatusChange", (status) => {
    if (status.connectionType === "wifi") fn();
  });
  return () => void handle.then((h) => h.remove()).catch(() => {});
}

/** Call `fn` each time the device gets ANY connection back (Wi-Fi or cellular). */
export function onConnected(fn: () => void): () => void {
  if (!available()) return () => {};
  const handle = Network.addListener("networkStatusChange", (status) => {
    if (status.connected) fn();
  });
  return () => void handle.then((h) => h.remove()).catch(() => {});
}
