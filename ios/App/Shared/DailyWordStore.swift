// =========================================================
// DailyWordStore — the hand-off between the app and its home-screen widgets.
//
// Compiled into BOTH targets (App + DailyWordWidget): the app writes, the widget reads.
// A widget extension is a separate process with its own sandbox, so the only storage
// the two share is the App Group container — hence UserDefaults(suiteName:) rather
// than .standard, and the `com.apple.security.application-groups` entitlement on both
// targets (App.entitlements / DailyWordWidget.entitlements). Without the entitlement
// nothing fails: each side silently gets a private suite and the widget stays empty.
//
// The value is the JSON string src/services/widget/dailyWord.ts builds, stored as-is.
// The structs below must stay in step with `DailyWordPayload` there.
// =========================================================
import Foundation

struct DailyWord: Codable, Hashable {
    let headword: String
    let reading: String?
    let meaning: String
    let level: String?
    let lang: String
    /// Displayed confidence 0–5 for a saved word; nil for a new one.
    let confidence: Int?
}

struct DailyWordPayload: Codable {
    let version: Int
    /// Local calendar day (yyyy-MM-dd) that index 0 of each list belongs to.
    let day: String
    let newWords: [DailyWord]
    let reviewWords: [DailyWord]
}

enum DailyWordStore {
    static let appGroup = "group.com.xaviergdelrosario.dino"
    static let key = "dailyWord.payload"
    /// Mirrors WIDGET_PAYLOAD_VERSION in dailyWord.ts. A payload from a newer app
    /// build that this widget can't read is treated as absent, not half-decoded.
    static let supportedVersion = 1

    static func save(json: String) {
        UserDefaults(suiteName: appGroup)?.set(json, forKey: key)
    }

    static func load() -> DailyWordPayload? {
        guard
            let json = UserDefaults(suiteName: appGroup)?.string(forKey: key),
            let data = json.data(using: .utf8),
            let payload = try? JSONDecoder().decode(DailyWordPayload.self, from: data),
            payload.version == supportedVersion
        else { return nil }
        return payload
    }
}
