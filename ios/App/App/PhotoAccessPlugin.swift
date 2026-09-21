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
        CAPPluginMethod(name: "listPhotos", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "loadPhoto", returnType: CAPPluginReturnPromise),
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

    /// The photos this app can actually see, newest first, as small JPEG thumbnails.
    ///
    /// This is the half PHPickerViewController cannot do. The picker runs out of process
    /// and will not tell us what is in the library — it only hands back what the user
    /// taps. Fetching PHAssets ourselves is what makes an IN-APP grid possible, and under
    /// limited access it returns exactly the shared selection, which is the honest thing
    /// to show next to a Manage button.
    ///
    /// Thumbnails, not originals: a grid of full-resolution images would be tens of MB
    /// across the bridge for pictures the user is only glancing at. The chosen one is
    /// fetched at size by loadPhoto.
    @objc func listPhotos(_ call: CAPPluginCall) {
        let limit = call.getInt("limit") ?? 60
        let edge = CGFloat(call.getInt("thumbSize") ?? 240)

        DispatchQueue.global(qos: .userInitiated).async {
            let options = PHFetchOptions()
            options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
            options.fetchLimit = limit
            let assets = PHAsset.fetchAssets(with: .image, options: options)

            let manager = PHImageManager.default()
            let request = PHImageRequestOptions()
            request.isSynchronous = true          // already off the main thread
            request.deliveryMode = .highQualityFormat
            request.resizeMode = .fast
            request.isNetworkAccessAllowed = true // iCloud-only photos still resolve

            var photos: [[String: Any]] = []
            assets.enumerateObjects { asset, _, _ in
                manager.requestImage(
                    for: asset,
                    targetSize: CGSize(width: edge, height: edge),
                    contentMode: .aspectFill,
                    options: request
                ) { image, _ in
                    guard let data = image?.jpegData(compressionQuality: 0.7) else { return }
                    photos.append([
                        "id": asset.localIdentifier,
                        "thumb": data.base64EncodedString(),
                    ])
                }
            }

            DispatchQueue.main.async {
                call.resolve(["photos": photos])
            }
        }
    }

    /// One photo at a size worth running OCR over. Capped rather than original: Vision
    /// gains nothing from a 12-megapixel source and the base64 has to cross the bridge.
    @objc func loadPhoto(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else {
            call.reject("Missing photo id")
            return
        }
        let maxEdge = CGFloat(call.getInt("maxSize") ?? 2048)

        DispatchQueue.global(qos: .userInitiated).async {
            let assets = PHAsset.fetchAssets(withLocalIdentifiers: [id], options: nil)
            guard let asset = assets.firstObject else {
                DispatchQueue.main.async { call.reject("Photo not found") }
                return
            }
            let request = PHImageRequestOptions()
            request.isSynchronous = true
            request.deliveryMode = .highQualityFormat
            request.resizeMode = .exact
            request.isNetworkAccessAllowed = true

            PHImageManager.default().requestImage(
                for: asset,
                targetSize: CGSize(width: maxEdge, height: maxEdge),
                contentMode: .aspectFit,
                options: request
            ) { image, _ in
                guard let data = image?.jpegData(compressionQuality: 0.85) else {
                    DispatchQueue.main.async { call.reject("Could not read that photo") }
                    return
                }
                DispatchQueue.main.async {
                    call.resolve(["base64": data.base64EncodedString(), "format": "jpeg"])
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
