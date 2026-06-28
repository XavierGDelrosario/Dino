// =========================================================
// Native recognizer — Google ML Kit Digital Ink Recognition, on-device, FREE,
// offline. Bridges to the custom iOS Capacitor plugin (the "DigitalInk" plugin,
// ios/App/App/DigitalInkPlugin.swift). iOS-only today: available() is false on
// web and in tests, so the registry falls through and the draw affordance hides.
//
// The TS↔Swift contract is the two methods below. ensureModel downloads the
// ~20MB per-language model once (over wifi); recognize() turns strokes into ranked
// candidates. Nothing here is web-specific beyond Capacitor's bridge, so a future
// Android build reuses this provider unchanged (just add the Android plugin).
// =========================================================

import { Capacitor, registerPlugin } from "@capacitor/core";
import type { LangCode } from "../../language";
import type { HandwritingRecognizer, InkInput, RecognitionCandidate } from "../types";

interface NativeStroke {
  points: { x: number; y: number; t?: number }[];
}

interface DigitalInkPlugin {
  /** Ensure the on-device model for `lang` is downloaded (idempotent; one-time
   *  ~20MB over wifi). Resolves once the model is present. */
  ensureModel(opts: { lang: string }): Promise<{ installed: boolean }>;
  recognize(opts: {
    lang: string;
    width: number;
    height: number;
    strokes: NativeStroke[];
  }): Promise<{ candidates: RecognitionCandidate[] }>;
}

const DigitalInk = registerPlugin<DigitalInkPlugin>("DigitalInk");

/**
 * App LangCode → ML Kit Digital Ink BCP-47 model tag (the subset we support).
 * Returns null for a language ML Kit can't draw-recognize → recognize() no-ops.
 */
function toInkLanguageTag(lang: LangCode): string | null {
  switch (lang.toUpperCase()) {
    case "JA":
      return "ja";
    case "EN":
      return "en";
    case "KO":
      return "ko";
    case "ZH":
      return "zh-Hani";
    default:
      return null;
  }
}

export const nativeRecognizer: HandwritingRecognizer = {
  id: "mlkit-digital-ink",

  available(): boolean {
    // isPluginAvailable guards the case where the JS expects the plugin but the
    // native build hasn't been (re)synced with the Swift plugin yet.
    return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable("DigitalInk");
  },

  supports(lang: LangCode): boolean {
    return toInkLanguageTag(lang) !== null;
  },

  async recognize(input: InkInput): Promise<RecognitionCandidate[]> {
    const tag = toInkLanguageTag(input.lang);
    if (!tag) return [];
    await DigitalInk.ensureModel({ lang: tag });
    const { candidates } = await DigitalInk.recognize({
      lang: tag,
      width: input.width,
      height: input.height,
      strokes: input.strokes.map((s) => ({ points: s.points })),
    });
    return candidates ?? [];
  },
};
