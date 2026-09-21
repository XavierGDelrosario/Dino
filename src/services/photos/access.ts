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

/** One photo the app can see: its PHAsset id, and a small JPEG for the grid. */
export interface LibraryPhoto {
  id: string;
  /** Base64 JPEG, thumbnail-sized — not the original. */
  thumb: string;
}

interface PhotoAccessPlugin {
  status(): Promise<{ status: PhotoAccess }>;
  /** The system "select more photos" picker; resolves with the status after it closes. */
  presentLimitedPicker(): Promise<{ status: PhotoAccess }>;
  openSettings(): Promise<void>;
  listPhotos(opts: { limit?: number; thumbSize?: number }): Promise<{ photos: LibraryPhoto[] }>;
  loadPhoto(opts: { id: string; maxSize?: number }): Promise<{ base64: string; format: string }>;
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

/**
 * The photos the app can currently see, newest first.
 *
 * Under limited access this is EXACTLY the shared selection — which is the point: it is
 * what an in-app grid should show, and what the Manage button then widens. The system
 * picker cannot supply this, because it runs out of process and reports only what the
 * user taps.
 *
 * Empty off-native, so the grid never renders in a browser.
 */
export async function listLibraryPhotos(limit = 60): Promise<LibraryPhoto[]> {
  if (!manageable()) return [];
  try {
    return (await PhotoAccessNative.listPhotos({ limit })).photos ?? [];
  } catch {
    return [];
  }
}

/** One photo at OCR resolution. Null rather than throwing: a photo that won't load is
 *  one tile of the grid failing, not the grid failing. */
export async function loadLibraryPhoto(id: string): Promise<{ base64: string; format: string } | null> {
  if (!manageable()) return null;
  try {
    return await PhotoAccessNative.loadPhoto({ id });
  } catch {
    return null;
  }
}
