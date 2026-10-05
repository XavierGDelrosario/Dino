// =========================================================
// OnDeviceTranslate — a local Capacitor plugin wrapping Google ML Kit's on-device
// Translation (free, offline once a language model is on the phone). It is the native
// backend behind src/services/translation/onDevice.ts (registerPlugin "OnDeviceTranslate").
// Contract = three methods, `source` / `target` being BCP-47 tags ("ja", "en", …):
//
//   isReady({ source, target })      -> { ready }        both language models present?
//   ensureModels({ source, target }) -> { installed }    download what is missing (Wi-Fi only)
//   translate({ source, target, texts }) -> { translations: [String | null] }
//
// `translations` is index-aligned with `texts`; a text that fails comes back null rather
// than failing the batch, so the JS side can keep each gloss under its own sentence.
//
// Models are ~30 MB per language and download over Wi-Fi ONLY, like the handwriting
// model. ML Kit reports nothing while it waits for a network it may use, so
// ensureModels can stay pending indefinitely off Wi-Fi — the JS side never waits on it.
//
// NOTE: requires the GoogleMLKit/Translate pod (see ios/App/Podfile).
// =========================================================
import Foundation
import Capacitor
import MLKitTranslate

@objc(OnDeviceTranslatePlugin)
public class OnDeviceTranslatePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "OnDeviceTranslatePlugin"
    public let jsName = "OnDeviceTranslate"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isReady", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "ensureModels", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "translate", returnType: CAPPluginReturnPromise),
    ]

    // Translators cached per pair: building one loads the models into memory, and ML Kit
    // needs a strong reference held across its async calls.
    private var translators: [String: Translator] = [:]

    /// A BCP-47 tag as an ML Kit language, or nil when ML Kit can't translate it.
    private func language(_ tag: String?) -> TranslateLanguage? {
        guard let tag = tag else { return nil }
        let lang = TranslateLanguage(rawValue: tag)
        return TranslateLanguage.allLanguages().contains(lang) ? lang : nil
    }

    private func pair(_ call: CAPPluginCall) -> (TranslateLanguage, TranslateLanguage)? {
        guard let source = language(call.getString("source")),
              let target = language(call.getString("target")) else {
            call.reject("Unsupported translation language")
            return nil
        }
        return (source, target)
    }

    private func translator(_ source: TranslateLanguage, _ target: TranslateLanguage) -> Translator {
        let key = "\(source.rawValue)>\(target.rawValue)"
        if let existing = translators[key] { return existing }
        let options = TranslatorOptions(sourceLanguage: source, targetLanguage: target)
        let translator = Translator.translator(options: options)
        translators[key] = translator
        return translator
    }

    private func modelsReady(_ source: TranslateLanguage, _ target: TranslateLanguage) -> Bool {
        let manager = ModelManager.modelManager()
        return manager.isModelDownloaded(TranslateRemoteModel.translateRemoteModel(language: source))
            && manager.isModelDownloaded(TranslateRemoteModel.translateRemoteModel(language: target))
    }

    @objc func isReady(_ call: CAPPluginCall) {
        guard let (source, target) = pair(call) else { return }
        call.resolve(["ready": modelsReady(source, target)])
    }

    @objc func ensureModels(_ call: CAPPluginCall) {
        guard let (source, target) = pair(call) else { return }
        if modelsReady(source, target) {
            call.resolve(["installed": true])
            return
        }
        let conditions = ModelDownloadConditions(allowsCellularAccess: false,
                                                 allowsBackgroundDownloading: true)
        translator(source, target).downloadModelIfNeeded(with: conditions) { error in
            if let error = error {
                call.reject("Translation model download failed: \(error.localizedDescription)")
            } else {
                call.resolve(["installed": true])
            }
        }
    }

    @objc func translate(_ call: CAPPluginCall) {
        guard let (source, target) = pair(call) else { return }
        guard modelsReady(source, target) else {
            call.reject("Translation model not downloaded")
            return
        }
        let texts = call.getArray("texts", String.self) ?? []
        let translator = self.translator(source, target)
        var results: [Any] = Array(repeating: NSNull(), count: texts.count)

        // One at a time, in order: the models are shared, and a failed text must leave
        // a null in ITS slot rather than shifting every gloss after it.
        func step(_ index: Int) {
            if index >= texts.count {
                call.resolve(["translations": results])
                return
            }
            translator.translate(texts[index]) { translated, error in
                if error == nil, let translated = translated {
                    results[index] = translated
                }
                step(index + 1)
            }
        }
        step(0)
    }
}
