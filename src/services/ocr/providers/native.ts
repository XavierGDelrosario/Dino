// =========================================================
// Native OCR — Apple Vision (VNRecognizeText), built-in, FREE, on-device, returns
// per-line bounding boxes + Japanese support. Bridges to the custom iOS Capacitor
// plugin "TextOcr" (ios/App/App/TextOcrPlugin.swift). The photo comes from
// @capacitor/camera; its base64 is handed to the plugin to recognize.
//
// iOS-only today: available() is false on web/desktop, so the registry falls
// through and the camera button hides. ML Kit Text Recognition is the cross-platform
// alternative if Android is added later (same plugin contract).
// =========================================================

import { Capacitor, registerPlugin } from "@capacitor/core";
import { Camera, CameraResultType, CameraSource } from "@capacitor/camera";
import type { LangCode } from "../../language";
import type { OcrRecognizer, OcrResult } from "../types";

interface TextOcrPlugin {
  recognize(opts: { image: string; lang: string }): Promise<OcrResult>;
}

const TextOcr = registerPlugin<TextOcrPlugin>("TextOcr");

/** App LangCode → Vision BCP-47 recognition language, or null if unsupported. */
function toVisionLanguage(lang: LangCode): string | null {
  switch (lang.toUpperCase()) {
    case "JA":
      return "ja";
    case "EN":
      return "en-US";
    case "ZH":
      return "zh-Hans";
    case "KO":
      return "ko";
    default:
      return null;
  }
}

export const nativeRecognizer: OcrRecognizer = {
  id: "apple-vision",

  available(): boolean {
    return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable("TextOcr");
  },

  supports(lang: LangCode): boolean {
    return toVisionLanguage(lang) !== null;
  },

  async capture({ lang }): Promise<OcrResult | null> {
    const tag = toVisionLanguage(lang);
    if (!tag) return null;
    let base64: string | undefined;
    try {
      const photo = await Camera.getPhoto({
        resultType: CameraResultType.Base64,
        source: CameraSource.Camera,
        correctOrientation: true,
        quality: 85,
      });
      base64 = photo.base64String;
    } catch (err) {
      // Backing out of the camera is a no-op → null. But a denied permission or
      // a device with no camera (e.g. the iOS simulator) is a REAL failure: don't
      // swallow it, or the UI misreports it as "no text found in the photo".
      if (isUserCancellation(err)) return null;
      throw err;
    }
    if (!base64) return null;
    return TextOcr.recognize({ image: base64, lang: tag });
  },
};

/** Capacitor signals a user-initiated cancel with a "cancel"/"cancelled" message;
 *  anything else (denied access, no camera available) is an error worth surfacing. */
function isUserCancellation(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return msg.includes("cancel");
}
