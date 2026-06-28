import { describe, it, expect, vi } from "vitest";

// No native platform in the unit env → stub Capacitor + the camera plugin so the
// facade degrades gracefully (registry finds no available backend).
vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false, isPluginAvailable: () => false },
  registerPlugin: () => ({ recognize: vi.fn() }),
}));
vi.mock("@capacitor/camera", () => ({
  Camera: { getPhoto: vi.fn() },
  CameraResultType: { Base64: "base64" },
  CameraSource: { Camera: "CAMERA" },
}));

import { isOcrAvailable, captureText, captureResult } from "@/services/ocr";

describe("ocr facade", () => {
  it("reports unavailable on web/test", async () => {
    expect(await isOcrAvailable()).toBe(false);
    expect(await isOcrAvailable("JA")).toBe(false);
  });

  it("captureText degrades to empty string when no backend", async () => {
    expect(await captureText({ lang: "JA" })).toBe("");
  });

  it("captureResult degrades to null when no backend", async () => {
    expect(await captureResult({ lang: "JA" })).toBeNull();
  });
});
