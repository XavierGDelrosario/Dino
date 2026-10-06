// Open this app's page in the OS Settings app — the only way back from a denied iOS
// permission (the system asks once; afterwards every request answers "denied" with no
// prompt). Native only: a browser has no equivalent, so the caller shows copy instead.
// Backed by the local AppSettings plugin (ios/App/App/AppSettingsPlugin.swift).
import { Capacitor, registerPlugin } from "@capacitor/core";

interface AppSettingsPlugin {
  open(): Promise<void>;
}

const Native = registerPlugin<AppSettingsPlugin>("AppSettings");

export function canOpenAppSettings(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable("AppSettings");
}

/** Resolves true when Settings opened. Never throws. */
export async function openAppSettings(): Promise<boolean> {
  if (!canOpenAppSettings()) return false;
  try {
    await Native.open();
    return true;
  } catch {
    return false;
  }
}
