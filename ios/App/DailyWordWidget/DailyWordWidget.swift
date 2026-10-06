// =========================================================
// DINO's home-screen widgets — one word a day, two flavours:
//
//   NewWordWidget    — an unseen word at the user's band
//   ReviewWordWidget — the saved word they are weakest on (a new word while there
//                      is nothing to review)
//
// The widget chooses NOTHING. The app writes a dated schedule into the App Group
// (src/services/widget/dailyWord.ts → DailyWordWidgetPlugin → Shared/DailyWordStore)
// and this file only indexes into it by calendar day, wrapping when the schedule runs
// out — so the word still turns over at midnight for someone who hasn't opened the app
// in weeks, and the extension needs no network, session or dictionary.
//
// Deployment target is iOS 15 like the app, hence the availability checks: lock-screen
// (accessory) families are 16+, and containerBackground is 17+ (and REQUIRED there —
// without it iOS 17 draws a "please adopt containerBackground" placeholder).
// =========================================================
import SwiftUI
import WidgetKit

// MARK: - Schedule

enum DailyWordKind {
    case new, review

    func words(in payload: DailyWordPayload) -> [DailyWord] {
        self == .new ? payload.newWords : payload.reviewWords
    }
}

enum DailyWordSchedule {
    /// Days of timeline handed to WidgetKit per reload. It re-asks at the end, so this
    /// only bounds how far ahead the entries are precomputed.
    static let horizon = 14

    private static let dayFormat: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    /// The word for `date`: schedule index = whole local days since the payload's `day`,
    /// wrapped (and safe for a clock set backwards).
    static func word(on date: Date, kind: DailyWordKind, payload: DailyWordPayload?) -> DailyWord? {
        guard let payload = payload, let start = dayFormat.date(from: payload.day) else { return nil }
        let words = kind.words(in: payload)
        guard !words.isEmpty else { return nil }
        let cal = Calendar.current
        let days = cal.dateComponents([.day], from: cal.startOfDay(for: start), to: cal.startOfDay(for: date)).day ?? 0
        let n = words.count
        return words[((days % n) + n) % n]
    }
}

struct DailyWordEntry: TimelineEntry {
    let date: Date
    let word: DailyWord?
}

struct DailyWordProvider: TimelineProvider {
    let kind: DailyWordKind

    private static let sample = DailyWord(
        headword: "猫", reading: "ねこ", meaning: "cat", level: "N5", lang: "JA", confidence: nil)

    func placeholder(in context: Context) -> DailyWordEntry {
        DailyWordEntry(date: Date(), word: Self.sample)
    }

    func getSnapshot(in context: Context, completion: @escaping (DailyWordEntry) -> Void) {
        let now = Date()
        let word = DailyWordSchedule.word(on: now, kind: kind, payload: DailyWordStore.load())
        // The widget gallery shows the snapshot: a sample reads better there than "open DINO".
        completion(DailyWordEntry(date: now, word: word ?? (context.isPreview ? Self.sample : nil)))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<DailyWordEntry>) -> Void) {
        let payload = DailyWordStore.load()
        let cal = Calendar.current
        let today = cal.startOfDay(for: Date())
        // One entry per local midnight, so the word flips with the date.
        let entries = (0..<DailyWordSchedule.horizon).compactMap { offset -> DailyWordEntry? in
            guard let day = cal.date(byAdding: .day, value: offset, to: today) else { return nil }
            return DailyWordEntry(date: day, word: DailyWordSchedule.word(on: day, kind: kind, payload: payload))
        }
        completion(Timeline(entries: entries, policy: .atEnd))
    }
}

// MARK: - Copy

/// The widget follows the DEVICE language (it cannot see the app's own UI-language
/// choice), in the two languages the app ships.
enum Copy {
    private static let ja = Locale.preferredLanguages.first?.hasPrefix("ja") ?? false

    static let newWord = ja ? "新しい単語" : "New word"
    static let review = ja ? "復習" : "Review"
    static let empty = ja ? "DINOを開くと今日の単語が届きます" : "Open DINO to get today's word"
    static let newTitle = ja ? "今日の新しい単語" : "New word of the day"
    static let newDescription = ja ? "あなたのレベルの新しい単語を毎日ひとつ。" : "A new word at your level, every day."
    static let reviewTitle = ja ? "今日の復習" : "Review word of the day"
    static let reviewDescription =
        ja ? "いちばん忘れかけている保存済みの単語を毎日ひとつ。" : "The saved word you're closest to forgetting, every day."
}

// MARK: - Palette

/// The app's palette (components/common/common.css), dark and light. A widget can't
/// read CSS tokens, so these are a hand copy — keep them in step with `:root` and
/// `:root[data-theme="light"]`. It follows the SYSTEM appearance, not the in-app theme.
struct Palette {
    let background: Color
    let text: Color
    let muted: Color
    /// --word-new: the "you can add this" blue.
    let new: Color
    /// --conf-0…5: the red→green confidence ramp.
    let confidence: [Color]

    init(_ scheme: ColorScheme) {
        if scheme == .dark {
            background = Color(hex: 0x1A1D24)
            text = Color(hex: 0xE8EAED)
            muted = Color(hex: 0x9AA0AB)
            new = Color(hex: 0x5B9DFF)
            confidence = [0xFF6B6B, 0xFF9F5A, 0xFFD166, 0xC9D65A, 0x7FCE6F, 0x3ECB6C].map(Color.init(hex:))
        } else {
            background = Color(hex: 0xFFFFFF)
            text = Color(hex: 0x1B1E26)
            muted = Color(hex: 0x5C6472)
            new = Color(hex: 0x206DE5)
            confidence = [0xE4281F, 0xC15707, 0x917300, 0x61810C, 0x1E8837, 0x098050].map(Color.init(hex:))
        }
    }

    func tint(for word: DailyWord) -> Color {
        guard let c = word.confidence else { return new }
        return confidence[min(max(c, 0), confidence.count - 1)]
    }
}

extension Color {
    init(hex: UInt32) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: 1)
    }
}

// MARK: - Views

struct DailyWordView: View {
    let entry: DailyWordEntry
    @Environment(\.widgetFamily) private var family
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let palette = Palette(scheme)
        if #available(iOSApplicationExtension 16.0, *), family == .accessoryRectangular {
            lockScreen.accessorySurface()
        } else if #available(iOSApplicationExtension 16.0, *), family == .accessoryInline {
            Text(entry.word.map { "\($0.headword) · \($0.meaning)" } ?? "DINO").accessorySurface()
        } else {
            Group {
                if let word = entry.word {
                    if family == .systemMedium {
                        medium(word, palette)
                    } else {
                        small(word, palette)
                    }
                } else {
                    Text(Copy.empty)
                        .font(.footnote)
                        .foregroundColor(palette.muted)
                        .multilineTextAlignment(.center)
                }
            }
            .homeSurface(palette.background)
        }
    }

    /// "NEW WORD            N5" / "REVIEW  3/5       N4"
    private func header(_ word: DailyWord, _ palette: Palette) -> some View {
        HStack(spacing: 6) {
            Text(word.confidence == nil ? Copy.newWord : Copy.review)
                .textCase(.uppercase)
                .foregroundColor(palette.tint(for: word))
            if let c = word.confidence {
                Text("\(c)/5").foregroundColor(palette.muted)
            }
            Spacer(minLength: 0)
            if let level = word.level {
                Text(level).foregroundColor(palette.muted)
            }
        }
        .font(.caption2.weight(.semibold))
        .lineLimit(1)
    }

    private func headword(_ word: DailyWord, size: CGFloat) -> some View {
        Text(word.headword)
            .font(.system(size: size, weight: .bold))
            .lineLimit(1)
            .minimumScaleFactor(0.35)
            // Han characters render with CHINESE glyph shapes on a non-Japanese device
            // unless the text is told its language (直, 骨, 海 are visibly different).
            .environment(\.locale, Locale(identifier: word.lang.lowercased()))
    }

    private func small(_ word: DailyWord, _ palette: Palette) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            header(word, palette)
            Spacer(minLength: 2)
            headword(word, size: 32).foregroundColor(palette.text)
            if let reading = word.reading {
                Text(reading).font(.footnote).foregroundColor(palette.muted).lineLimit(1)
            }
            Spacer(minLength: 2)
            Text(word.meaning)
                .font(.footnote)
                .foregroundColor(palette.text)
                .lineLimit(2)
                .minimumScaleFactor(0.85)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private func medium(_ word: DailyWord, _ palette: Palette) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            header(word, palette)
            HStack(alignment: .center, spacing: 14) {
                VStack(alignment: .leading, spacing: 2) {
                    headword(word, size: 40).foregroundColor(palette.text)
                    if let reading = word.reading {
                        Text(reading).font(.subheadline).foregroundColor(palette.muted).lineLimit(1)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                Text(word.meaning)
                    .font(.callout)
                    .foregroundColor(palette.text)
                    .lineLimit(4)
                    .minimumScaleFactor(0.85)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxHeight: .infinity)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    /// Lock screen: the system tints everything one colour, so no palette here.
    private var lockScreen: some View {
        VStack(alignment: .leading, spacing: 1) {
            if let word = entry.word {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    headword(word, size: 17)
                    if let reading = word.reading {
                        Text(reading).font(.caption2).lineLimit(1)
                    }
                }
                Text(word.meaning).font(.caption).lineLimit(2)
            } else {
                Text(Copy.empty).font(.caption)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private extension View {
    /// Home-screen background. iOS 17+ owns the margins and wants the background
    /// declared; earlier versions get both drawn by hand.
    @ViewBuilder func homeSurface(_ color: Color) -> some View {
        if #available(iOSApplicationExtension 17.0, *) {
            containerBackground(color, for: .widget)
        } else {
            padding(14)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(color)
        }
    }

    /// Lock-screen widgets have no background of their own, but iOS 17 still requires
    /// the declaration.
    @ViewBuilder func accessorySurface() -> some View {
        if #available(iOSApplicationExtension 17.0, *) {
            containerBackground(.clear, for: .widget)
        } else {
            self
        }
    }
}

// MARK: - Widgets

private var supportedFamilies: [WidgetFamily] {
    if #available(iOSApplicationExtension 16.0, *) {
        return [.systemSmall, .systemMedium, .accessoryRectangular, .accessoryInline]
    }
    return [.systemSmall, .systemMedium]
}

struct NewWordWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "DinoNewWord", provider: DailyWordProvider(kind: .new)) { entry in
            DailyWordView(entry: entry)
        }
        .configurationDisplayName(Copy.newTitle)
        .description(Copy.newDescription)
        .supportedFamilies(supportedFamilies)
    }
}

struct ReviewWordWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "DinoReviewWord", provider: DailyWordProvider(kind: .review)) { entry in
            DailyWordView(entry: entry)
        }
        .configurationDisplayName(Copy.reviewTitle)
        .description(Copy.reviewDescription)
        .supportedFamilies(supportedFamilies)
    }
}

@main
struct DinoWidgets: WidgetBundle {
    var body: some Widget {
        NewWordWidget()
        ReviewWordWidget()
    }
}
