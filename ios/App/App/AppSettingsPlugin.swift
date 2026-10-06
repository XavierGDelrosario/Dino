// =========================================================
// AppSettings — a local Capacitor plugin with one job: open THIS app's page in the
// iOS Settings app (UIApplication.openSettingsURLString).
//
//   open() -> {}
//
// Why: iOS asks for a permission (notifications, here) exactly ONCE. After "Don't
// Allow", every later request answers "denied" without a prompt, and the only way the
// user can change their mind is Settings → DINO → Notifications. A WKWebView cannot
// open the `app-settings:` scheme itself, so the page asks native. No pod; registered
// in MainViewController.capacitorDidLoad like the other local plugins.
// =========================================================
import Foundation
import Capacitor
import UIKit

@objc(AppSettingsPlugin)
public class AppSettingsPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AppSettingsPlugin"
    public let jsName = "AppSettings"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
    ]

    @objc func open(_ call: CAPPluginCall) {
        guard let url = URL(string: UIApplication.openSettingsURLString) else {
            call.reject("settings url unavailable")
            return
        }
        DispatchQueue.main.async {
            UIApplication.shared.open(url, options: [:]) { ok in
                if ok { call.resolve() } else { call.reject("could not open settings") }
            }
        }
    }
}
