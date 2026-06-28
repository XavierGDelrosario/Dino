import { describe, it, expect, vi } from "vitest";

// No native platform in the unit env → stub Capacitor to the "web" answer and the
// plugin to a bare object. Exercises the facade's graceful degradation (registry
// finds no available backend).
vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false },
  registerPlugin: () => ({}),
}));
vi.mock("@capacitor-community/speech-recognition", () => ({
  SpeechRecognition: {
    available: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    checkPermissions: vi.fn(),
    requestPermissions: vi.fn(),
  },
}));

import { isSpeechAvailable, startSpeech, stopSpeech } from "@/services/speech";

describe("speech facade", () => {
  it("reports unavailable on web/test", async () => {
    expect(await isSpeechAvailable()).toBe(false);
  });

  it("startSpeech degrades to [] when no backend is usable", async () => {
    expect(await startSpeech({ lang: "JA" })).toEqual([]);
  });

  it("stopSpeech is a no-op when nothing is listening", async () => {
    await expect(stopSpeech()).resolves.toBeUndefined();
  });
});
