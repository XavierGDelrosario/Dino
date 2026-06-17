// =========================================================
// Public surface of the language module. Import from "./language".
//
//   registry.ts  what languages exist (data, types, script matchers)
//   detect.ts    auto-detect + source resolution
//   options.ts   UI dropdown view-models
//   tokenize.ts  paragraph -> word tokens (with offsets)
//   analyze.ts   tokens + readings/lemmas (kuromoji for JA; segmentation else)
//   furigana.ts  reading annotations (furigana/pinyin) per side
// =========================================================

export * from "./registry";
export * from "./detect";
export * from "./options";
export * from "./tokenize";
export * from "./analyze";
export * from "./furigana";
