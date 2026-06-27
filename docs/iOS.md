# iOS (Capacitor) — dev-device builds

Goal: install DINO on a **dev iPhone** to test the on-device features (speech,
camera/OCR, handwriting). **App Store is NOT a goal yet.** Capacitor wraps the
existing built web app (`dist/`) in a native iOS shell — the whole React app runs
unchanged in a WebView; `services/` stays platform-neutral.

## What's already scaffolded (no Xcode needed)
- `@capacitor/core` + `@capacitor/cli` + `@capacitor/ios` (Capacitor 8).
- Plugins: `@capacitor/camera`, `@capacitor-community/speech-recognition`.
- `capacitor.config.ts` (appId `com.dino.app`, webDir `dist`).
- Scripts: `npm run ios:build` (build vs PROD + sync), `ios:sync`, `ios:open`.
- `.gitignore` covers the generated iOS build artifacts (Pods, web copy, DerivedData).

The web build still passes unchanged (the plugins aren't imported yet — they get
wired in once the project builds on a device).

## One-time prerequisites (YOU)
1. **Install full Xcode** from the Mac App Store (you currently have only the Command
   Line Tools). Then: `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`
   and open Xcode once to accept the license + install components.
2. **CocoaPods**: `brew install cocoapods` (or `sudo gem install cocoapods`).
3. **Apple ID** (free) signed into Xcode → Settings → Accounts. A free account can
   sign + install on **your own device** (7-day provisioning). The **$99/yr Apple
   Developer Program is NOT needed** until TestFlight/App Store.
4. A **real iPhone** + USB cable (speech + camera need real hardware; the Simulator
   can't. Handwriting works in the Simulator via trackpad).

## Package manager: CocoaPods (NOT the Cap 8 SPM default)
Capacitor 8 defaults to Swift Package Manager, but `@capacitor-community/speech-recognition`
(latest 7.0.1, a Cap-7 release) ships **no `Package.swift`**, so it's not SPM-compatible.
We therefore generate the iOS project with **CocoaPods** so speech + camera both work:
```bash
npx cap add ios --packagemanager CocoaPods    # if regenerating ios/, KEEP this flag
```
The `ios/` project is committed (Pods / web-copy / build are gitignored). If a Cap-8
speech plugin with SPM support appears later, we can switch back to SPM.

## Run the iOS project (after the prereqs)
```bash
npm run ios:build        # builds vs PROD Supabase + syncs dist/ into ios/
npm run ios:open         # opens ios/App/App.xcworkspace in Xcode
```
In Xcode: select your iPhone as the run target → **Signing & Capabilities** → pick
your Apple ID team (auto-manage signing) → press ▶. First run: on the phone, trust
the developer cert in **Settings → General → VPN & Device Management**.

## Permissions to add (in `ios/App/App/Info.plist`, after `cap add ios`)
- `NSMicrophoneUsageDescription` — "Used for speech-to-text vocabulary capture."
- `NSSpeechRecognitionUsageDescription` — "Used to transcribe spoken Japanese."
- `NSCameraUsageDescription` — "Used to scan text from photos."

## Feature wiring status (the next phase — done WITH device testing)
| Feature | Plugin | Status |
|---|---|---|
| Speech-to-text (JA) | `@capacitor-community/speech-recognition` | installed; wire to an input mic button → feeds `analyze()` |
| Camera → OCR (JA) | `@capacitor/camera` + ML Kit text recognition | camera installed; OCR plugin TBD during wiring |
| Handwriting (draw a kanji) | ML Kit Digital Ink | ⚠️ no mature Capacitor plugin — needs a small custom Swift plugin; lowest priority |

All three output plain text → the existing `analyze()` → JMdict pipeline, so nothing
downstream changes.

## Notes
- The bundled build points at **prod** (`ios:build`) because a phone can't reach local
  `127.0.0.1`. For live-reload against your Mac's dev server, set `server.url` in
  `capacitor.config.ts` to `http://<your-LAN-IP>:5173` (dev only — remove before any
  real build).
- `speech-recognition` is currently the Cap-7 plugin (`7.0.1`) on Cap 8 — verify it
  builds; bump to a Cap-8 release if one exists, else it typically still works.
- iOS could later drop the ~17 MB kuromoji `/dict` payload for the OS `NLTagger`
  (the single `analyze()` swap point) — not needed to start.
