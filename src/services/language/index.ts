// =========================================================
// Public surface of the language module. Import from "./language".
//
//   registry.ts  what languages exist (data, types, script matchers)
//   detect.ts    auto-detect + source resolution
//   options.ts   UI dropdown view-models
//   tokenize.ts  paragraph -> word tokens (with offsets)
//   sentences.ts paragraph -> sentences (with offsets), the inline-gloss unit
//   analyze.ts   tokens + readings/lemmas (kuromoji for JA; segmentation else)
//   furigana.ts  reading annotations (furigana/pinyin) per side
//   partOfSpeech.ts  JMdict POS codes -> one coarse learner-facing category
//   romaji.ts    romaji -> hiragana, for SEARCH only (all-or-nothing)
// =========================================================

export * from "./registry";
export * from "./detect";
export * from "./options";
export * from "./tokenize";
export * from "./sentences";
export * from "./analyze";
export * from "./furigana";
export * from "./partOfSpeech";
export * from "./romaji";
