// =========================================================
// DigitalInk — a local Capacitor plugin wrapping Google ML Kit Digital Ink
// Recognition (on-device, free, offline). It is the native backend behind the JS
// handwriting seam (src/services/handwriting/providers/native.ts → registerPlugin
// "DigitalInk"). Contract = two methods:
//
//   ensureModel({ lang })  -> { installed }   download the ~20MB model once (wifi)
//   recognize({ lang, width, height, strokes }) -> { candidates: [{text, score}] }
//
// `lang` is a BCP-47 ink model tag ("ja","en","ko","zh-Hani"); `strokes` is
// [{ points: [{x,y,t}] }] in the canvas's pixel space (the JS side sends exactly
// this). Capacitor 8 auto-registers CAPBridgedPlugin conformers — no .m file.
//
// NOTE: requires the GoogleMLKit/DigitalInkRecognition pod (see ios/App/Podfile)
// and a device/simulator build. UNVERIFIED in this environment — needs:
//   npm run build && npx cap sync ios && (cd ios/App && pod install) && open in Xcode.
// =========================================================
import Foundation
import Capacitor
import MLKitDigitalInkRecognition

@objc(DigitalInkPlugin)
public class DigitalInkPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "DigitalInkPlugin"
    public let jsName = "DigitalInk"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "ensureModel", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "recognize", returnType: CAPPluginReturnPromise),
    ]

    private let modelManager = ModelManager.modelManager()

    // Recognizers cached per language tag: building one is expensive (loads the
    // model into memory) so recreating it per call made recognition slow. The cache
    // also keeps a strong reference, which ML Kit requires across the async call.
    private var recognizers: [String: DigitalInkRecognizer] = [:]

    private func recognizer(forTag tag: String, model: DigitalInkRecognitionModel) ->   DigitalInkRecognizer {
        if let existing = recognizers[tag] { return existing }
        let options = DigitalInkRecognizerOptions(model: model)
        let recognizer = DigitalInkRecognizer.digitalInkRecognizer(options: options)
        recognizers[tag] = recognizer
        return recognizer
    }

    /// Resolve the on-device model for a BCP-47 tag (nil if ML Kit can't draw it).
    /// The identifier initializer is BOTH failable and throwing: it throws on a
    /// malformed tag and returns nil for an unsupported one — handle both → nil.
    private func model(forTag tag: String) -> DigitalInkRecognitionModel? {
        do {
            guard let identifier = try DigitalInkRecognitionModelIdentifier(forLanguageTag: tag) else {
                return nil
            }
            return DigitalInkRecognitionModel(modelIdentifier: identifier)
        } catch {
            return nil
        }
    }

    /// Download the language model once (idempotent). Resolves when present.
    @objc func ensureModel(_ call: CAPPluginCall) {
        guard let tag = call.getString("lang"), let model = model(forTag: tag) else {
            call.reject("Unsupported handwriting language")
            return
        }
        if modelManager.isModelDownloaded(model) {
            call.resolve(["installed": true])
            return
        }
        // wifi-only so a ~20MB model never downloads over cellular (matches the
        // kuromoji /dict/ payload policy on the web side).
        let conditions = ModelDownloadConditions(allowsCellularAccess: false,
                                                 allowsBackgroundDownloading: true)
        var succeeded: NSObjectProtocol?
        var failed: NSObjectProtocol?
        let cleanup = {
            if let s = succeeded { NotificationCenter.default.removeObserver(s) }
            if let f = failed { NotificationCenter.default.removeObserver(f) }
        }
        succeeded = NotificationCenter.default.addObserver(
            forName: .mlkitModelDownloadDidSucceed, object: nil, queue: .main
        ) { _ in
            cleanup()
            call.resolve(["installed": true])
        }
        failed = NotificationCenter.default.addObserver(
            forName: .mlkitModelDownloadDidFail, object: nil, queue: .main
        ) { _ in
            cleanup()
            call.reject("Handwriting model download failed")
        }
        modelManager.download(model, conditions: conditions)
    }

    /// Recognize the drawn strokes into ranked candidates.
    @objc func recognize(_ call: CAPPluginCall) {
        guard let tag = call.getString("lang"), let model = model(forTag: tag) else {
            call.reject("Unsupported handwriting language")
            return
        }
        guard modelManager.isModelDownloaded(model) else {
            call.reject("Handwriting model not downloaded")
            return
        }

        let width = Float(call.getDouble("width") ?? 0)
        let height = Float(call.getDouble("height") ?? 0)

        let rawStrokes = call.getArray("strokes", JSObject.self) ?? []
        var strokes: [Stroke] = []
        for rawStroke in rawStrokes {
            guard let rawPoints = rawStroke["points"] as? [JSObject] else { continue }
            var points: [StrokePoint] = []
            for p in rawPoints {
                let x = Float((p["x"] as? Double) ?? 0)
                let y = Float((p["y"] as? Double) ?? 0)
                let t = Int((p["t"] as? Double) ?? 0)
                points.append(StrokePoint(x: x, y: y, t: t))
            }
            if !points.isEmpty { strokes.append(Stroke(points: points)) }
        }
        guard !strokes.isEmpty else {
            call.resolve(["candidates": []])
            return
        }

        let ink = Ink(strokes: strokes)
        // The writing-area context tells ML Kit the canvas size, which materially
        // improves CJK accuracy (the docs note it "may lead to better accuracy").
        let writingArea = WritingArea(width: width, height: height)
        let context = DigitalInkRecognitionContext(preContext: "", writingArea: writingArea)
        let recognizer = self.recognizer(forTag: tag, model: model)
        recognizer.recognize(ink: ink, context: context) { result, error in
            if let error = error {
                call.reject("Recognition failed: \(error.localizedDescription)")
                return
            }
            let candidates: [JSObject] = (result?.candidates ?? []).map { candidate in
                var obj = JSObject()
                obj["text"] = candidate.text
                if let score = candidate.score { obj["score"] = score.doubleValue }
                return obj
            }
            call.resolve(["candidates": candidates])
        }
    }
}
