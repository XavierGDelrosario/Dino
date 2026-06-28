// =========================================================
// Counter-reading seam — the per-language swap point for 助数詞 (Japanese counters)
// and their cross-language analogues (Chinese measure words, …). A morphological
// engine (kuromoji) gives a counter its CITATION reading (三本 → ホン) and never the
// euphonic form (さんぼん); a resolver supplies the corrected readings.
//
// Abstract + swappable on two levels (mirrors language/registry.ts + senses/difficulty):
//   1. per-LANGUAGE — registry.ts maps a LangCode to a CounterResolver (JA today).
//   2. per-language the resolver is data-driven (japanese.ts) and itself swappable
//      behind this one-method interface.
// =========================================================

/** Corrected hiragana readings for a number+counter pair. */
export interface CounterReading {
  /** Reading for the number, or null to leave it as kuromoji gave it (no euphonic
   *  change, or a bare ASCII digit that needs no furigana). */
  numberReading: string | null;
  /** Reading for the counter token. */
  counterReading: string;
  /** When true, `numberReading` is a jukujikun spanning the WHOLE number run (二十歳 →
   *  はたち over 二十), so the caller blanks the other number tokens. Default/false:
   *  `numberReading` applies only to the LAST number token (gemination / ones-digit,
   *  e.g. 十四日 → じゅうよっか keeps 十=じゅう). */
  replacesRun?: boolean;
}

export interface CounterResolver {
  /**
   * Corrected readings for `value` + `counter` (the counter's surface form, e.g. 本),
   * or null when the counter isn't recognized (caller leaves the engine's reading).
   * `value` is the parsed integer of the preceding number run (三 → 3, 二十三 → 23).
   */
  resolve(value: number, counter: string): CounterReading | null;
}
