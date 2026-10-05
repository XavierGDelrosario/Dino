// The on-device translator never WAITS for a language model: the download is Wi-Fi only
// and silent while it waits, so a pair that isn't ready fails at once (having started
// the download) and the caller falls back to the cloud.
import { describe, it, expect, vi, beforeEach } from "vitest";

const { plugin, native } = vi.hoisted(() => ({
  plugin: { isReady: vi.fn(), ensureModels: vi.fn(), translate: vi.fn() },
  native: { on: true },
}));
vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => native.on, isPluginAvailable: () => native.on },
  registerPlugin: () => plugin,
}));

import {
  canTranslateOnDevice,
  translateOnDevice,
  OnDeviceUnavailableError,
  __resetOnDeviceDownloads,
} from "@/services/translation/onDevice";

const PARAMS = { segments: ["猫が好き。", "犬も好き。"], sourceLang: "JA" as const, targetLang: "EN" as const };

beforeEach(() => {
  native.on = true;
  plugin.isReady.mockReset().mockResolvedValue({ ready: true });
  plugin.ensureModels.mockReset().mockReturnValue(new Promise(() => {}));
  plugin.translate.mockReset().mockResolvedValue({ translations: ["I like cats.", "I like dogs too."] });
  __resetOnDeviceDownloads();
});

describe("canTranslateOnDevice", () => {
  it("is the app only, and needs two different supported languages", () => {
    expect(canTranslateOnDevice("JA", "EN")).toBe(true);
    expect(canTranslateOnDevice("EN", "JA")).toBe(true);
    expect(canTranslateOnDevice("JA", "JA")).toBe(false);
    native.on = false;
    expect(canTranslateOnDevice("JA", "EN")).toBe(false);
  });
});

describe("translateOnDevice", () => {
  it("translates each segment, index-aligned", async () => {
    expect(await translateOnDevice(PARAMS)).toEqual(["I like cats.", "I like dogs too."]);
    expect(plugin.translate).toHaveBeenCalledWith({ source: "ja", target: "en", texts: PARAMS.segments });
  });

  it("a segment that came back empty is null, and a short answer never shifts the rest", async () => {
    plugin.translate.mockResolvedValue({ translations: [null] });
    expect(await translateOnDevice(PARAMS)).toEqual([null, null]);
    plugin.translate.mockResolvedValue({ translations: ["", "second"] });
    expect(await translateOnDevice(PARAMS)).toEqual([null, "second"]);
  });

  it("models not on the phone → fails AT ONCE and starts the download once", async () => {
    plugin.isReady.mockResolvedValue({ ready: false });
    await expect(translateOnDevice(PARAMS)).rejects.toBeInstanceOf(OnDeviceUnavailableError);
    await expect(translateOnDevice(PARAMS)).rejects.toBeInstanceOf(OnDeviceUnavailableError);
    expect(plugin.ensureModels).toHaveBeenCalledTimes(1);
    expect(plugin.translate).not.toHaveBeenCalled();
  });

  it("a failed download is asked for again next time", async () => {
    plugin.isReady.mockResolvedValue({ ready: false });
    plugin.ensureModels.mockRejectedValue(new Error("download failed"));
    await expect(translateOnDevice(PARAMS)).rejects.toBeInstanceOf(OnDeviceUnavailableError);
    await new Promise((r) => setTimeout(r, 0));
    await expect(translateOnDevice(PARAMS)).rejects.toBeInstanceOf(OnDeviceUnavailableError);
    expect(plugin.ensureModels).toHaveBeenCalledTimes(2);
  });

  it("outside the app it is unavailable, without touching the plugin", async () => {
    native.on = false;
    await expect(translateOnDevice(PARAMS)).rejects.toBeInstanceOf(OnDeviceUnavailableError);
    expect(plugin.isReady).not.toHaveBeenCalled();
  });
});
