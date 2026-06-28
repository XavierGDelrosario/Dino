// =========================================================
// TextOcr — a local Capacitor plugin wrapping Apple's Vision text recognizer
// (VNRecognizeText): on-device, FREE, no pod (Vision is built-in), Japanese
// supported (iOS 16+). It is the native backend behind the JS OCR seam
// (src/services/ocr/providers/native.ts → registerPlugin "TextOcr"). Contract:
//
//   recognize({ image: <base64 jpeg>, lang: <bcp47> })
//     -> { width, height, blocks: [{ text, x, y, width, height }] }
//
// Boxes are NORMALIZED 0..1 with a TOP-LEFT origin (Vision's are bottom-left — we
// convert), matching the OcrBlock type. The photo comes from @capacitor/camera;
// only the recognition lives here. Registered in MainViewController.capacitorDidLoad.
//
// NOTE: needs a device/simulator build; add this file to the App target in Xcode.
// =========================================================
import Foundation
import Capacitor
import Vision
import UIKit

@objc(TextOcrPlugin)
public class TextOcrPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "TextOcrPlugin"
    public let jsName = "TextOcr"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "recognize", returnType: CAPPluginReturnPromise),
    ]

    @objc func recognize(_ call: CAPPluginCall) {
        guard let b64 = call.getString("image"),
              let data = Data(base64Encoded: b64),
              let image = UIImage(data: data),
              let cg = image.cgImage else {
            call.reject("Invalid image")
            return
        }
        let lang = call.getString("lang") ?? "ja"
        let pxW = Double(cg.width)
        let pxH = Double(cg.height)

        let request = VNRecognizeTextRequest { request, error in
            if let error = error {
                call.reject("Recognition failed: \(error.localizedDescription)")
                return
            }
            let observations = (request.results as? [VNRecognizedTextObservation]) ?? []
            var blocks: [JSObject] = []
            for obs in observations {
                guard let candidate = obs.topCandidates(1).first else { continue }
                let bb = obs.boundingBox // normalized, bottom-left origin
                var block = JSObject()
                block["text"] = candidate.string
                block["x"] = Double(bb.minX)
                block["y"] = Double(1.0 - bb.maxY) // → top-left origin
                block["width"] = Double(bb.width)
                block["height"] = Double(bb.height)
                blocks.append(block)
            }
            call.resolve(["width": pxW, "height": pxH, "blocks": blocks])
        }
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = true
        request.recognitionLanguages = [lang, "en-US"]

        // .up: the camera plugin's correctOrientation bakes rotation into the pixels.
        let handler = VNImageRequestHandler(cgImage: cg, orientation: .up, options: [:])
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                try handler.perform([request])
            } catch {
                call.reject("Recognition failed: \(error.localizedDescription)")
            }
        }
    }
}
