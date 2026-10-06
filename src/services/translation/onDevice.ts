// On-device translation — Google ML Kit, in the iOS app only (the "OnDeviceTranslate"
// plugin, ios/App/App/OnDeviceTranslatePlugin.swift). Free and offline once a language
// model is on the phone, so it never touches the paid quota.
//
// It is the ROUGHER translator — Google's own words are "casual and simple" — which is
// why it is used only where it replaces nothing better: a guest's sentence glosses, and
// anyone's once their cloud allowance is spent. Its output is DISPLAY-ONLY. Only the
// server may write a verified word, so nothing translated here can enter the shared
// `words` cache.
//
// The models (~30 MB per language) download over Wi-Fi only, and ML Kit says nothing
// while it waits for a network it may use. So this module never waits for a download:
// a pair that isn't ready throws `OnDeviceUnavailableError` at once, having started the
// download in the background, and the caller falls back to what it would have done.

import { Capacitor, registerPlugin } from "@capacitor/core";
import type { LangCode } from "../language";

interface OnDeviceTranslatePlugin {
  isReady(opts: { source: string; target: string }): Promise<{ ready: boolean }>;
  ensureModels(opts: { source: string; target: string }): Promise<{ installed: boolean }>;
  translate(opts: {
    source: string;
    target: string;
    texts: string[];
  }): Promise<{ translations: (string | null)[] }>;
}

const OnDeviceTranslate = registerPlugin<OnDeviceTranslatePlugin>("OnDeviceTranslate");

/** App LangCode → ML Kit's BCP-47 tag, for the languages the app pairs today. */
function tag(lang: LangCode): string | null {
  switch (lang.toUpperCase()) {
    case "JA":
      return "ja";
    case "EN":
      return "en";
    case "KO":
      return "ko";
    case "ZH":
      return "zh";
    default:
      return null;
  }
}

/** This pair can't be translated on the device right now (not the app, an unsupported
 *  language, or its models are still downloading). Never a translation failure. */
export class OnDeviceUnavailableError extends Error {
  constructor(reason: string) {
    super(`On-device translation unavailable: ${reason}`);
    this.name = "OnDeviceUnavailableError";
  }
}

/** Could this pair EVER be translated on this device? (Says nothing about the models.) */
export function canTranslateOnDevice(sourceLang: LangCode, targetLang: LangCode): boolean {
  return (
    Capacitor.isNativePlatform() &&
    Capacitor.isPluginAvailable("OnDeviceTranslate") &&
    tag(sourceLang) !== null &&
    tag(targetLang) !== null &&
    tag(sourceLang) !== tag(targetLang)
  );
}

/** Model downloads already asked for, so a burst of glosses starts each one once. */
const downloading = new Set<string>();

/** Test hook: the set above is module-global. */
export function __resetOnDeviceDownloads(): void {
  downloading.clear();
}

/**
 * Translate each segment on the device, index-aligned with `segments` (null = that one
 * came back empty). Throws `OnDeviceUnavailableError` — immediately, never after a wait
 * — when the pair isn't usable yet.
 */
export async function translateOnDevice(params: {
  segments: string[];
  sourceLang: LangCode;
  targetLang: LangCode;
}): Promise<(string | null)[]> {
  if (!canTranslateOnDevice(params.sourceLang, params.targetLang)) {
    throw new OnDeviceUnavailableError("not supported here");
  }
  if (params.segments.length === 0) return [];
  const pair = { source: tag(params.sourceLang)!, target: tag(params.targetLang)! };

  if (!(await OnDeviceTranslate.isReady(pair)).ready) {
    const key = `${pair.source}>${pair.target}`;
    if (!downloading.has(key)) {
      downloading.add(key);
      // Fire and forget: it lands whenever Wi-Fi allows, and the NEXT call finds it.
      void OnDeviceTranslate.ensureModels(pair)
        .catch(() => {})
        .finally(() => downloading.delete(key));
    }
    throw new OnDeviceUnavailableError("language models are still downloading");
  }

  const { translations } = await OnDeviceTranslate.translate({ ...pair, texts: params.segments });
  // Never let a short response shift the alignment — pad to the request.
  return params.segments.map((_, i) => translations?.[i] || null);
}
