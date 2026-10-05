// =========================================================
// DailyWordWidget — a local Capacitor plugin that feeds the home-screen widgets.
//
//   setPayload({ json }) -> {}   store the schedule, then reload the widget timelines
//
// The web app picks the words (src/services/widget/dailyWord.ts) because only it has
// the user's session; this is the one-way door into the App Group container the widget
// extension reads (Shared/DailyWordStore.swift). The JSON is stored untouched — the
// widget decodes it — so a payload change never needs a change here.
//
// No pod: WidgetKit is built-in. Registered in MainViewController.capacitorDidLoad,
// like the other local plugins — Capacitor does NOT auto-discover app-target plugins.
// =========================================================
import Foundation
import Capacitor
import WidgetKit

@objc(DailyWordWidgetPlugin)
public class DailyWordWidgetPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "DailyWordWidgetPlugin"
    public let jsName = "DailyWordWidget"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setPayload", returnType: CAPPluginReturnPromise),
    ]

    @objc func setPayload(_ call: CAPPluginCall) {
        guard let json = call.getString("json") else {
            call.reject("json is required")
            return
        }
        DailyWordStore.save(json: json)
        WidgetCenter.shared.reloadAllTimelines()
        call.resolve()
    }
}
