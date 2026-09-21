// =========================================================
// iOS LIMITED photo access — the state, and the two ways out of it.
//
// When the system photo prompt is answered with "Limit Access", iOS never asks again.
// The only routes to a wider selection are its own "select more photos" picker and
// Settings › DINO, and an app that offers neither leaves the user stuck with a choice
// they may have made by reflex. That is what this seam is for.
//
// ‼️ IT IS AN AFFORDANCE, NOT A CAPABILITY GATE. Do not branch the OCR flow on it. The
// picker DINO opens is PHPickerViewController, which runs out of process and shows the
// user's whole library under either grant, handing back only the chosen image (through
// the picker result's itemProvider, never a PHAsset). So limited access does not
// actually restrict what can be scanned — it restricts what the user BELIEVES is
// reachable, because the system prompt told them "limited". Widening it changes the
// message, not the reach.
//
// Native-only, and inert everywhere else: `manageable()` is false on web, so the UI
// that hangs off this never renders in a browser. Mirrors services/ocr and
// services/handwriting — a thin typed wrapper over a local Capacitor plugin.
// =========================================================
import { Capacitor, registerPlugin } from "@capacitor/core";

/** What the user granted. `prompt` = not asked yet; `denied` covers restricted. */
export type PhotoAccess = "full" | "limited" | "denied" | "prompt";

interface PhotoAccessPlugin {
  status(): Promise<{ status: PhotoAccess }>;
  /** The system "select more photos" picker; resolves with the status after it closes. */
  presentLimitedPicker(): Promise<{ status: PhotoAccess }>;
  openSettings(): Promise<void>;
}

const PhotoAccessNative = registerPlugin<PhotoAccessPlugin>("PhotoAccess");

/** Is there a native side at all? False on web, so the Manage UI stays off. */
export function manageable(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable("PhotoAccess");
}

/**
 * Current grant. Resolves to `full` off-native and on any native failure: this decides
 * only whether to OFFER the Manage bar, so the safe default is not to nag — a spurious
 * "you're limited" on a device that isn't would be worse than staying quiet.
 */
export async function photoAccess(): Promise<PhotoAccess> {
  if (!manageable()) return "full";
  try {
    return (await PhotoAccessNative.status()).status;
  } catch {
    return "full";
  }
}

/** Open the system picker for widening the selection. Returns the grant afterwards —
 *  the user can switch to full access from inside it, which retires the bar. */
export async function selectMorePhotos(): Promise<PhotoAccess> {
  if (!manageable()) return "full";
  try {
    return (await PhotoAccessNative.presentLimitedPicker()).status;
  } catch {
    return photoAccess();
  }
}

/** Hand off to Settings › DINO, the only place full access can still be granted.
 *  The app is backgrounded by this, so the caller re-reads the grant on resume. */
export async function openPhotoSettings(): Promise<void> {
  if (!manageable()) return;
  try {
    await PhotoAccessNative.openSettings();
  } catch {
    // Nothing useful to say: the user is either in Settings or still here, and both
    // are visible to them. Re-reading the grant on resume covers either outcome.
  }
}
