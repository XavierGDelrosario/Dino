import { describe, it, expect, vi } from "vitest";

// The native provider imports @capacitor/core; in the unit env there's no native
// platform, so stub it to the "web" answer (no plugin) — exercising the facade's
// graceful degradation (the registry finds no available backend).
vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => false,
    isPluginAvailable: () => false,
  },
  registerPlugin: () => ({
    ensureModel: vi.fn(),
    recognize: vi.fn(),
  }),
}));

import { recognizeHandwriting, isHandwritingAvailable } from "@/services/handwriting";

describe("handwriting facade", () => {
  it("returns no candidates when there are no strokes (no backend touched)", async () => {
    const out = await recognizeHandwriting({ strokes: [], width: 280, height: 280, lang: "JA" });
    expect(out).toEqual([]);
  });

  it("reports unavailable and degrades to [] when no backend is usable (web/test)", async () => {
    expect(await isHandwritingAvailable()).toBe(false);
    const out = await recognizeHandwriting({
      strokes: [{ points: [{ x: 1, y: 1 }, { x: 2, y: 2 }] }],
      width: 280,
      height: 280,
      lang: "JA",
    });
    expect(out).toEqual([]);
  });
});
