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
import { HandwritingModelPendingError } from "../types";
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

/** How long a drawing waits for the model before the pad says it is still downloading. */
export const MODEL_WAIT_MS = 8000;

/**
 * Model downloads in flight, per ink tag. The native side downloads over Wi-Fi ONLY
 * (`allowsCellularAccess: false`) and ML Kit reports nothing while it waits for a
 * network it may use — off Wi-Fi the call simply never settles, and the pad spun
 * forever. So the wait is bounded here, measured from when the download was first
 * asked for: every stroke shares the one native call, and once the wait is spent a
 * later stroke is told at once rather than spinning for another full wait.
 */
const downloads = new Map<string, { done: Promise<void>; startedAt: number }>();

/** Test hook: the map above is module-global. */
export function __resetModelDownloads(): void {
  downloads.clear();
}

async function ensureModel(tag: string): Promise<void> {
  let download = downloads.get(tag);
  if (!download) {
    const done = DigitalInk.ensureModel({ lang: tag }).then(
      () => { downloads.delete(tag); },
      (e) => { downloads.delete(tag); throw e; }, // a failed download is retried by the next stroke
    );
    done.catch(() => {}); // a waiter that already timed out must not leave it unhandled
    download = { done, startedAt: Date.now() };
    downloads.set(tag, download);
  }
  const left = MODEL_WAIT_MS - (Date.now() - download.startedAt);
  if (left <= 0) throw new HandwritingModelPendingError();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new HandwritingModelPendingError()), left);
  });
  try {
    await Promise.race([download.done, timeout]);
  } finally {
    clearTimeout(timer);
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
    await ensureModel(tag);
    const { candidates } = await DigitalInk.recognize({
      lang: tag,
      width: input.width,
      height: input.height,
      strokes: input.strokes.map((s) => ({ points: s.points })),
    });
    return candidates ?? [];
  },
};
