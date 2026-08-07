// The camera/library split is ONE argument deep, and getting it wrong is silent:
// the wrong sheet opens and the user just thinks the button is the other button.
// The facade's own spec can't cover it (no native platform there → no backend), so
// this drives the native provider directly with Capacitor faked as native.
import { describe, it, expect, vi, beforeEach } from "vitest";

const getPhoto = vi.fn();

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => true, isPluginAvailable: () => true },
  registerPlugin: () => ({ recognize: vi.fn() }),
}));
vi.mock("@capacitor/camera", () => ({
  Camera: { getPhoto: (...args: unknown[]) => getPhoto(...args) },
  CameraResultType: { Base64: "base64" },
  // The real enum values, so a swapped constant fails here rather than on a device.
  CameraSource: { Camera: "CAMERA", Photos: "PHOTOS", Prompt: "PROMPT" },
}));

import { nativeRecognizer } from "@/services/ocr/providers/native";

const sourceOf = () => (getPhoto.mock.calls[0][0] as { source: string }).source;

describe("native OCR recognizer — image source", () => {
  beforeEach(() => {
    getPhoto.mockReset();
    getPhoto.mockResolvedValue({ base64String: "AAAA", format: "jpeg" });
  });

  it("defaults to the camera when no source is given", async () => {
    await nativeRecognizer.captureImage();
    expect(sourceOf()).toBe("CAMERA");
  });

  it("opens the camera for source: camera", async () => {
    await nativeRecognizer.captureImage({ source: "camera" });
    expect(sourceOf()).toBe("CAMERA");
  });

  it("opens the photo LIBRARY for source: library", async () => {
    await nativeRecognizer.captureImage({ source: "library" });
    expect(sourceOf()).toBe("PHOTOS");
  });

  // Prompt is Capacitor's own "Camera or Photos?" action sheet. The UI asks that
  // question with two buttons, so reaching it would mean asking twice.
  it("never uses Capacitor's Prompt sheet", async () => {
    await nativeRecognizer.captureImage({ source: "library" });
    await nativeRecognizer.captureImage({ source: "camera" });
    for (const call of getPhoto.mock.calls) {
      expect((call[0] as { source: string }).source).not.toBe("PROMPT");
    }
  });

  it("carries the source through the combined capture() path", async () => {
    await nativeRecognizer.capture({ lang: "JA", source: "library" });
    expect(sourceOf()).toBe("PHOTOS");
  });

  it("returns null when the user backs out of the picker", async () => {
    getPhoto.mockRejectedValueOnce(new Error("User cancelled photos app"));
    expect(await nativeRecognizer.captureImage({ source: "library" })).toBeNull();
  });

  // A denied photo-library permission is NOT a cancellation: swallowing it would
  // surface as "no text found" on an image the user never got to choose.
  it("rethrows a denied library permission", async () => {
    getPhoto.mockRejectedValueOnce(new Error("User denied access to photos"));
    await expect(nativeRecognizer.captureImage({ source: "library" })).rejects.toThrow();
  });
});
