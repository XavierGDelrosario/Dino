// The model download is Wi-Fi only and ML Kit says nothing while it waits for a
// network it may use, so off Wi-Fi the native call never settles. The provider has to
// bound that wait itself, or the draw pad spins forever.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { plugin } = vi.hoisted(() => ({
  plugin: { ensureModel: vi.fn(), recognize: vi.fn() },
}));
vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => true, isPluginAvailable: () => true },
  registerPlugin: () => plugin,
}));

import {
  nativeRecognizer,
  MODEL_WAIT_MS,
  __resetModelDownloads,
} from "@/services/handwriting/providers/native";
import { HandwritingModelPendingError } from "@/services/handwriting";

const INK = { strokes: [{ points: [{ x: 1, y: 1, t: 0 }] }], width: 280, height: 280, lang: "JA" as const };

beforeEach(() => {
  vi.useFakeTimers();
  plugin.ensureModel.mockReset();
  plugin.recognize.mockReset().mockResolvedValue({ candidates: [{ text: "猫" }] });
  __resetModelDownloads();
});
afterEach(() => vi.useRealTimers());

describe("native handwriting — model download", () => {
  it("recognizes straight away when the model is present", async () => {
    plugin.ensureModel.mockResolvedValue({ installed: true });
    await expect(nativeRecognizer.recognize(INK)).resolves.toEqual([{ text: "猫" }]);
  });

  it("stops waiting when the download never settles (off Wi-Fi)", async () => {
    plugin.ensureModel.mockReturnValue(new Promise(() => {}));

    const out = nativeRecognizer.recognize(INK);
    const settled = expect(out).rejects.toBeInstanceOf(HandwritingModelPendingError);
    await vi.advanceTimersByTimeAsync(MODEL_WAIT_MS);
    await settled;
    expect(plugin.recognize).not.toHaveBeenCalled();
  });

  it("a later stroke shares the one download and is told at once, not after another wait", async () => {
    plugin.ensureModel.mockReturnValue(new Promise(() => {}));

    const first = expect(nativeRecognizer.recognize(INK)).rejects.toBeInstanceOf(HandwritingModelPendingError);
    await vi.advanceTimersByTimeAsync(MODEL_WAIT_MS);
    await first;

    await expect(nativeRecognizer.recognize(INK)).rejects.toBeInstanceOf(HandwritingModelPendingError);
    expect(plugin.ensureModel).toHaveBeenCalledTimes(1);
  });

  it("works again once the download lands", async () => {
    let land!: (v: { installed: boolean }) => void;
    plugin.ensureModel.mockReturnValueOnce(new Promise((r) => (land = r)));

    const first = expect(nativeRecognizer.recognize(INK)).rejects.toBeInstanceOf(HandwritingModelPendingError);
    await vi.advanceTimersByTimeAsync(MODEL_WAIT_MS);
    await first;

    land({ installed: true });
    await vi.advanceTimersByTimeAsync(0);
    plugin.ensureModel.mockResolvedValue({ installed: true });
    await expect(nativeRecognizer.recognize(INK)).resolves.toEqual([{ text: "猫" }]);
  });

  it("a FAILED download surfaces as a failure and the next stroke retries it", async () => {
    plugin.ensureModel.mockRejectedValueOnce(new Error("Handwriting model download failed"));
    await expect(nativeRecognizer.recognize(INK)).rejects.toThrow("download failed");

    plugin.ensureModel.mockResolvedValue({ installed: true });
    await expect(nativeRecognizer.recognize(INK)).resolves.toEqual([{ text: "猫" }]);
    expect(plugin.ensureModel).toHaveBeenCalledTimes(2);
  });
});
