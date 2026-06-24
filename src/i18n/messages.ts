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

  // generic actions
  "common.add": "Add",
  "common.cancel": "Cancel",
  "common.create": "Create",
  "common.close": "Close",
  "common.save": "Save",
  "common.loadMore": "Load more",

  // lists surface
  "lists.allWords": "All words",
  "lists.allChip": "ALL",
  "lists.newList": "＋ New list",
  "lists.newListPlaceholder": "List name",
  "lists.newListAria": "New list name",
  "lists.reviewTitle": "Review this list with flashcards",
  "lists.reviewBtn": "▶ Review",
  "lists.deleteConfirm": "Delete the list \"{name}\"? Words stay in your vocabulary.",
  "lists.deleteListTitle": "Delete this sub-list",
  "lists.deleteListBtn": "Delete list",
  "lists.sortAria": "Sort words",
  "lists.sortNewest": "Newest first",
  "lists.sortOldest": "Oldest first",
  "lists.sortConfAsc": "Confidence: low → high",
  "lists.sortConfDesc": "Confidence: high → low",
  "lists.langFilterAria": "Filter by input language",
  "lists.allLanguages": "All languages",
  "lists.confRangeTitle": "Filter by confidence range",
  "lists.confidenceRange": "Confidence {min}–{max}",
  "lists.confMinAria": "Minimum confidence",
  "lists.confMaxAria": "Maximum confidence",
  "lists.emptyList": "No words tagged into this list yet.",
  "lists.emptyAll": "No words yet — translate some, or add a custom one above.",
  "lists.noMatch": "No words match this filter.",
  // add forms
  "lists.addWordToggle": "＋ Add word",
  "lists.addCustomToggle": "＋ Add custom word",
  "lists.wordLangAria": "Word language",
  "lists.meaningLangAria": "Meaning language",
  "lists.wordPlaceholder": "Word",
  "lists.wordLookupAria": "Word to look up",
  "lists.customWordAria": "Custom word",
  "lists.meaningPlaceholder": "Meaning",
  "lists.customMeaningAria": "Custom meaning",
  "lists.noMatchFor": "No dictionary match for \"{input}\".",
  "lists.addedPrefix": "✓ Added",
  "lists.hideOthers": "Hide other meanings",
  "lists.otherMeanings": "Other meanings ({n})",
  // row
  "lists.editMeaningAria": "Edit meaning",
  "lists.editMeaningTitle": "Edit meaning",
  "lists.addToSublist": "Add to a sub-list",
  "lists.addListOption": "＋ list",
  "lists.removeFromList": "Remove from this list (keeps it in your vocabulary)",
  "lists.deleteFromVocab": "Delete from vocabulary",
  "lists.confidenceOf": "confidence {n} of 5",
  "lists.infoAria": "Added {added}, last reviewed {reviewed}",
  "lists.infoTitle": "Added: {added}\nLast reviewed: {reviewed}",
  "lists.never": "never",
  // period filter
  "lists.added": "Added",
  "lists.addedAria": "Filter by date added",
  "lists.reviewed": "Reviewed",
  "lists.reviewedAria": "Filter by date last reviewed",
  "period.allTime": "all time",
  "period.today": "today",
  "period.week": "this week",
  "period.month": "this month",
  "period.year": "this year",
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

  "common.add": "追加",
  "common.cancel": "キャンセル",
  "common.create": "作成",
  "common.close": "閉じる",
  "common.save": "保存",
  "common.loadMore": "もっと読み込む",

  "lists.allWords": "すべての単語",
  "lists.allChip": "すべて",
  "lists.newList": "＋ 新しいリスト",
  "lists.newListPlaceholder": "リスト名",
  "lists.newListAria": "新しいリスト名",
  "lists.reviewTitle": "このリストをフラッシュカードで復習",
  "lists.reviewBtn": "▶ 復習",
  "lists.deleteConfirm": "リスト「{name}」を削除しますか？単語は語彙に残ります。",
  "lists.deleteListTitle": "このサブリストを削除",
  "lists.deleteListBtn": "リストを削除",
  "lists.sortAria": "単語を並べ替え",
  "lists.sortNewest": "新しい順",
  "lists.sortOldest": "古い順",
  "lists.sortConfAsc": "自信度：低い → 高い",
  "lists.sortConfDesc": "自信度：高い → 低い",
  "lists.langFilterAria": "入力言語でフィルター",
  "lists.allLanguages": "すべての言語",
  "lists.confRangeTitle": "自信度の範囲でフィルター",
  "lists.confidenceRange": "自信度 {min}–{max}",
  "lists.confMinAria": "最小自信度",
  "lists.confMaxAria": "最大自信度",
  "lists.emptyList": "このリストにはまだ単語がありません。",
  "lists.emptyAll": "まだ単語がありません — 翻訳するか、上からカスタム単語を追加してください。",
  "lists.noMatch": "このフィルターに一致する単語はありません。",
  "lists.addWordToggle": "＋ 単語を追加",
  "lists.addCustomToggle": "＋ カスタム単語を追加",
  "lists.wordLangAria": "単語の言語",
  "lists.meaningLangAria": "意味の言語",
  "lists.wordPlaceholder": "単語",
  "lists.wordLookupAria": "調べる単語",
  "lists.customWordAria": "カスタム単語",
  "lists.meaningPlaceholder": "意味",
  "lists.customMeaningAria": "カスタム意味",
  "lists.noMatchFor": "「{input}」の辞書一致がありません。",
  "lists.addedPrefix": "✓ 追加しました",
  "lists.hideOthers": "他の意味を隠す",
  "lists.otherMeanings": "他の意味（{n}）",
  "lists.editMeaningAria": "意味を編集",
  "lists.editMeaningTitle": "意味を編集",
  "lists.addToSublist": "サブリストに追加",
  "lists.addListOption": "＋ リスト",
  "lists.removeFromList": "このリストから削除（語彙には残ります）",
  "lists.deleteFromVocab": "語彙から削除",
  "lists.confidenceOf": "自信度 5段階中{n}",
  "lists.infoAria": "追加日 {added}、最終復習 {reviewed}",
  "lists.infoTitle": "追加日：{added}\n最終復習：{reviewed}",
  "lists.never": "なし",
  "lists.added": "追加",
  "lists.addedAria": "追加日でフィルター",
  "lists.reviewed": "復習",
  "lists.reviewedAria": "最終復習日でフィルター",
  "period.allTime": "全期間",
  "period.today": "今日",
  "period.week": "今週",
  "period.month": "今月",
  "period.year": "今年",
};

export const LOCALES = [
  { code: "en", label: "English" },
  { code: "ja", label: "日本語" },
] as const;

export type Locale = (typeof LOCALES)[number]["code"];

export const messages: Record<Locale, Record<MessageKey, string>> = { en, ja };
