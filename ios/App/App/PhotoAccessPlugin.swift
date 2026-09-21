// =========================================================
// PhotoAccess — a local Capacitor plugin for the iOS LIMITED photo library, the
// state @capacitor/camera reports but gives you nothing to act on.
//
//   status()               -> { status: "full" | "limited" | "denied" | "prompt" }
//   presentLimitedPicker() -> {} (after the system "select more photos" sheet closes)
//   openSettings()         -> {} (after handing off to Settings › DINO)
//
// WHY NOT @capacitor/camera. It has pickLimitedLibraryPhotos(), which presents the
// same system picker — but its completion then calls getLimitedLibraryPhotos(), which
// fetches EVERY selected PHAsset and renders each one to a file to hand back to JS.
// We want the sheet and nothing else: the photo itself arrives later through the
// ordinary picker. On a user with a large selection that is a lot of work thrown away.
//
// WHY THIS IS NEEDED AT ALL, given the picker sees everything. PHPickerViewController
// runs out of process and shows the whole library under either grant, so limited access
// does not actually restrict what can be scanned. It restricts what the user BELIEVES
// is reachable — the system prompt says "limited", so a way to widen it has to exist or
// the app looks broken. This is the affordance, not a capability gate.
//
// No pod: Photos and UIKit are built-in. Registered in MainViewController
// .capacitorDidLoad, like TextOcr and DigitalInk — Capacitor does NOT auto-discover
// app-target plugins. Add this file to the App target in Xcode.
// =========================================================
import Foundation
import Capacitor
import Photos
// PhotosUI, not just Photos: presentLimitedLibraryPicker(from:completionHandler:) is
// declared there as an extension on PHPhotoLibrary, so with Photos alone this file
// compiles right up to that one call and then fails on "no member".
import PhotosUI
import UIKit

@objc(PhotoAccessPlugin)
public class PhotoAccessPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "PhotoAccessPlugin"
    public let jsName = "PhotoAccess"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "presentLimitedPicker", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openSettings", returnType: CAPPluginReturnPromise),
    ]

    /// `.readWrite`, matching what @capacitor/camera's checkPermissions reads, so the
    /// two can never disagree about the same grant.
    private func currentStatus() -> String {
        switch PHPhotoLibrary.authorizationStatus(for: .readWrite) {
        case .authorized: return "full"
        case .limited: return "limited"
        case .denied, .restricted: return "denied"
        case .notDetermined: return "prompt"
        @unknown default: return "prompt"
        }
    }

    @objc func status(_ call: CAPPluginCall) {
        call.resolve(["status": currentStatus()])
    }

    /// The system's own "select more photos" picker. Resolves with the status AFTER it
    /// closes: the user can switch to full access from inside it, and the caller needs
    /// to know that so it can put the Manage bar away.
    @objc func presentLimitedPicker(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self, let viewController = self.bridge?.viewController else {
                call.reject("No view controller to present from")
                return
            }
            // Only meaningful under .limited; presenting it otherwise is a no-op that
            // never calls back, so answer immediately instead of hanging the promise.
            guard PHPhotoLibrary.authorizationStatus(for: .readWrite) == .limited else {
                call.resolve(["status": self.currentStatus()])
                return
            }
            PHPhotoLibrary.shared().presentLimitedLibraryPicker(from: viewController) { _ in
                DispatchQueue.main.async {
                    call.resolve(["status": self.currentStatus()])
                }
            }
        }
    }

    /// Settings › DINO, where the Photos row is the only place full access can be
    /// granted once the prompt has been answered — iOS never asks twice.
    @objc func openSettings(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let url = URL(string: UIApplication.openSettingsURLString),
                  UIApplication.shared.canOpenURL(url) else {
                call.reject("Cannot open Settings")
                return
            }
            UIApplication.shared.open(url, options: [:]) { opened in
                opened ? call.resolve() : call.reject("Cannot open Settings")
            }
        }
    }
}
