// The iOS limited-photo-access seam.
//
// What's pinned is the part that decides whether any of this UI exists at all, and the
// bias built into it: every failure resolves to "full", because this only chooses
// whether to OFFER the Manage button. A wrong "limited" nags a user who isn't, on every
// platform including the web — worse than staying quiet.
import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.hoisted, because access.ts calls registerPlugin at MODULE scope: the mock factory
// is hoisted above these declarations and would otherwise close over undefined.
const { status, presentLimitedPicker, openSettings, addListener, isNativePlatform, isPluginAvailable } = vi.hoisted(
  () => ({
    addListener: vi.fn(),
    status: vi.fn(),
    presentLimitedPicker: vi.fn(),
    openSettings: vi.fn(),
    isNativePlatform: vi.fn(),
    isPluginAvailable: vi.fn(),
  }),
);

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => isNativePlatform(),
    isPluginAvailable: (n: string) => isPluginAvailable(n),
  },
  registerPlugin: () => ({ status, presentLimitedPicker, openSettings, addListener }),
}));

import {
  manageable,
  photoAccess,
  selectMorePhotos,
  openPhotoSettings,
  onLibraryChange,
} from "@/services/photos/access";

/** A native device with the plugin compiled in. */
const onDevice = () => {
  isNativePlatform.mockReturnValue(true);
  isPluginAvailable.mockReturnValue(true);
};

beforeEach(() => {
  vi.clearAllMocks();
  isNativePlatform.mockReturnValue(false);
  isPluginAvailable.mockReturnValue(false);
});

describe("photo access — availability", () => {
  it("is not manageable on the web", () => {
    expect(manageable()).toBe(false);
  });

  it("is not manageable on a native build without the plugin compiled in", () => {
    isNativePlatform.mockReturnValue(true);
    isPluginAvailable.mockReturnValue(false);
    expect(manageable()).toBe(false);
  });

  it("is manageable on a device that has it", () => {
    onDevice();
    expect(manageable()).toBe(true);
  });
});

describe("photo access — reading the grant", () => {
  it("reports full on the web without calling the plugin", async () => {
    await expect(photoAccess()).resolves.toBe("full");
    expect(status).not.toHaveBeenCalled();
  });

  it("passes the device's grant straight through", async () => {
    onDevice();
    status.mockResolvedValue({ status: "limited" });
    await expect(photoAccess()).resolves.toBe("limited");
  });

  it("falls back to full when the plugin throws, so it never nags wrongly", async () => {
    onDevice();
    status.mockRejectedValue(new Error("boom"));
    await expect(photoAccess()).resolves.toBe("full");
  });
});

describe("photo access — widening it", () => {
  it("returns the grant the picker reports as it closes", async () => {
    onDevice();
    // The user can switch to full access from inside the system picker, and that is
    // what retires the Manage button — so this value matters, not just the call.
    presentLimitedPicker.mockResolvedValue({ status: "full" });
    await expect(selectMorePhotos()).resolves.toBe("full");
  });

  it("re-reads the grant if the picker itself fails", async () => {
    onDevice();
    presentLimitedPicker.mockRejectedValue(new Error("no view controller"));
    status.mockResolvedValue({ status: "limited" });
    await expect(selectMorePhotos()).resolves.toBe("limited");
  });

  it("opens settings on a device and is a no-op on the web", async () => {
    await openPhotoSettings();
    expect(openSettings).not.toHaveBeenCalled();
    onDevice();
    openSettings.mockResolvedValue(undefined);
    await openPhotoSettings();
    expect(openSettings).toHaveBeenCalledTimes(1);
  });

  it("swallows a failed hand-off to Settings rather than surfacing it", async () => {
    onDevice();
    openSettings.mockRejectedValue(new Error("cannot open"));
    // The user is either in Settings or still here; both are visible to them, and the
    // resume re-read covers either outcome.
    await expect(openPhotoSettings()).resolves.toBeUndefined();
  });
});

describe("photo access — library change events", () => {
  it("does nothing off-native", () => {
    const stop = onLibraryChange(() => {});
    expect(addListener).not.toHaveBeenCalled();
    stop();
  });

  it("subscribes to the native event and removes it on unsubscribe", async () => {
    onDevice();
    const remove = vi.fn();
    addListener.mockResolvedValue({ remove });
    const fn = vi.fn();
    const stop = onLibraryChange(fn);
    expect(addListener).toHaveBeenCalledWith("libraryChange", fn);
    await Promise.resolve();
    stop();
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("drops a listener that only arrives after the caller already unsubscribed", async () => {
    onDevice();
    const remove = vi.fn();
    let resolve!: (h: { remove: () => void }) => void;
    addListener.mockReturnValue(new Promise((r) => (resolve = r)));
    const stop = onLibraryChange(() => {});
    stop();
    resolve({ remove });
    await Promise.resolve();
    await Promise.resolve();
    expect(remove).toHaveBeenCalledTimes(1);
  });
});
