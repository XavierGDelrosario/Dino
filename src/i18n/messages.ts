// =========================================================
// UI string catalog (#17 i18n). Lightweight + in-house — no react-i18next — to
// match the codebase's minimal-deps, framework-light style and keep the catalog
// portable for a future native shell (#18).
//
// `en` is the SOURCE OF TRUTH. Every other locale is typed `Record<MessageKey,
// string>`, so a missing or renamed key is a COMPILE error — translations can't
// silently drift. Interpolate with `{name}` placeholders (see i18n/index.tsx `t`).
//
// UI LANGUAGE = the user's NATIVE language (the chrome), DISTINCT from the
// translation source/target languages chosen in LangBar.
// =========================================================

export const en = {
  // generic
  "common.loading": "Loading…",
  "common.word": "word",
  "common.words": "words",
  "ui.language": "Language",

  // app shell
  "app.startingSession": "Starting session…",
  "app.sessionErrorTitle": "Couldn’t start a session.",
  "tabs.translate": "Translate",
  "tabs.lists": "Lists",
  "tabs.review": "Review",

  // translate surface
  "translate.inputPlaceholder": "Type a word or a sentence…",
  "translate.inputAria": "Text to translate",
  "translate.outputAria": "Translation",
  "translate.outputPlaceholder": "Translation",
  "translate.translating": "Translating…",
  "translate.submit": "Translate",
  "translate.learning": "I'm learning:",
  "translate.learningAria": "Language I'm learning",
  "translate.addAll": "+ Add all {n} new {noun}",
  "translate.quizNew": "Quiz {n} new {noun}",
  "translate.reviewSaved": "Review {n} saved {noun}",
  "translate.explore": "Explore related words",
  "translate.exploreLoading": "Finding related words…",
  "translate.noDomain":
    "No related words at your level — try a longer or more common passage.",
} as const;

export type MessageKey = keyof typeof en;

export const ja: Record<MessageKey, string> = {
  "common.loading": "読み込み中…",
  "common.word": "単語",
  "common.words": "単語",
  "ui.language": "言語",

  "app.startingSession": "セッションを開始しています…",
  "app.sessionErrorTitle": "セッションを開始できませんでした。",
  "tabs.translate": "翻訳",
  "tabs.lists": "リスト",
  "tabs.review": "復習",

  "translate.inputPlaceholder": "単語または文章を入力…",
  "translate.inputAria": "翻訳するテキスト",
  "translate.outputAria": "翻訳",
  "translate.outputPlaceholder": "翻訳",
  "translate.translating": "翻訳中…",
  "translate.submit": "翻訳",
  "translate.learning": "学習中の言語：",
  "translate.learningAria": "学習する言語",
  "translate.addAll": "新しい{noun}{n}個をすべて追加",
  "translate.quizNew": "新しい{noun}{n}個をクイズ",
  "translate.reviewSaved": "保存済みの{noun}{n}個を復習",
  "translate.explore": "関連語を探す",
  "translate.exploreLoading": "関連語を検索中…",
  "translate.noDomain":
    "あなたのレベルに合う関連語が見つかりません。より長い、または一般的な文章をお試しください。",
};

export const LOCALES = [
  { code: "en", label: "English" },
  { code: "ja", label: "日本語" },
] as const;

export type Locale = (typeof LOCALES)[number]["code"];

export const messages: Record<Locale, Record<MessageKey, string>> = { en, ja };
