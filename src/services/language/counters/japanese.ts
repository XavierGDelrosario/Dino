// =========================================================
// Japanese 助数詞 (counter) readings — the JA CounterResolver.
//
// kuromoji splits 三本 → 三(サン) + 本(ホン) and gives each its citation reading, never
// the euphonic form さんぼん. This applies the regular morphophonology and enumerates the
// genuinely-suppletive residue. The counter system is a CLOSED class, so this converges
// (unlike the open-ended server-side default-sense overrides). Coverage tiers:
//
//   RULE-GOVERNED (a class + a flag, not enumeration):
//     * gemination (促音) — 1/6/8/10/100 + counter → っ; for h-row the initial mora
//       half-voices (ほ→ぽ): 一本いっぽん, 六本ろっぽん. s-row geminates on 1/8/10 only.
//     * rendaku (連濁) on 3 — h-row voices (ほ→ぼ: 三本さんぼん); flagged k/s counters too
//       (三階さんがい, 三足さんぞく). pOn3 counters take p not b (三分さんぷん, 三歩さんぽ).
//     * wago counters — take NATIVE numerals (一晩ひとばん, 二間ふたま) for 1–10.
//     * per-counter number readings — 四時よじ / 七時しちじ / 九時くじ (時).
//
//   SUPPLETIVE (enumerated in IRREGULARS): the 日 series (ついたち…), 一人ひとり/二人ふたり,
//     二十歳はたち. `replacesRun` marks readings that span a MULTI-token number (二十歳),
//     vs ones-digit-only ones (十四日 → じゅうよっか).
//
// The native generic つ series (一つひとつ…) is NOT here: kuromoji already returns it as a
// single token with the right reading. Adding a counter = a COUNTERS row; a quirk = a flag
// or an IRREGULARS row. Unknown counter → null → reader keeps kuromoji's reading.
// =========================================================
import type { CounterReading, CounterResolver } from "./types";

/** Euphonic behaviour class. "s" = geminate-no-rendaku (covers さ/た/ち/つ/て initials). */
type Euphonic = "h" | "k" | "s" | "wago" | "regular";

interface CounterInfo {
  reading: string;
  euphonic: Euphonic;
  /** k/s counters that ALSO voice on 3 (階→がい, 軒→げん, 足→ぞく; 個/冊 do not). */
  rendaku3?: boolean;
  /** h counters that take semivoiced p (not voiced b) on 3 (分→さんぷん, 歩→さんぽ). */
  pOn3?: boolean;
  /** Override the (last) number-token reading by governing digit (時: 4→よ, 7→しち, 9→く). */
  numberByDigit?: Record<number, string>;
}

const COUNTERS: Record<string, CounterInfo> = {
  // h-row (rendaku → b on 3)
  本: { reading: "ほん", euphonic: "h" },
  杯: { reading: "はい", euphonic: "h" },
  匹: { reading: "ひき", euphonic: "h" },
  // h-row, p-on-3 (さんぷん, not さんぶん)
  分: { reading: "ふん", euphonic: "h", pOn3: true },
  泊: { reading: "はく", euphonic: "h", pOn3: true },
  歩: { reading: "ほ", euphonic: "h", pOn3: true },
  // k-row (gemination, counter unchanged; rendaku3 voices on 3)
  個: { reading: "こ", euphonic: "k" },
  回: { reading: "かい", euphonic: "k" },
  課: { reading: "か", euphonic: "k" },
  機: { reading: "き", euphonic: "k" },
  曲: { reading: "きょく", euphonic: "k" },
  局: { reading: "きょく", euphonic: "k" },
  件: { reading: "けん", euphonic: "k" },
  巻: { reading: "かん", euphonic: "k" },
  階: { reading: "かい", euphonic: "k", rendaku3: true },
  軒: { reading: "けん", euphonic: "k", rendaku3: true },
  ヶ月: { reading: "かげつ", euphonic: "k" },
  か月: { reading: "かげつ", euphonic: "k" },
  // s-row (geminate on 1/8/10, counter unchanged; rendaku3 voices on 3)
  冊: { reading: "さつ", euphonic: "s" },
  歳: { reading: "さい", euphonic: "s" },
  才: { reading: "さい", euphonic: "s" },
  隻: { reading: "せき", euphonic: "s" },
  着: { reading: "ちゃく", euphonic: "s" },
  通: { reading: "つう", euphonic: "s" },
  点: { reading: "てん", euphonic: "s" },
  頭: { reading: "とう", euphonic: "s" },
  足: { reading: "そく", euphonic: "s", rendaku3: true },
  // regular (no euphonic change)
  枚: { reading: "まい", euphonic: "regular" },
  台: { reading: "だい", euphonic: "regular" },
  人: { reading: "にん", euphonic: "regular" },
  番: { reading: "ばん", euphonic: "regular" },
  円: { reading: "えん", euphonic: "regular" },
  年: { reading: "ねん", euphonic: "regular" },
  度: { reading: "ど", euphonic: "regular" },
  倍: { reading: "ばい", euphonic: "regular" },
  行: { reading: "ぎょう", euphonic: "regular" },
  語: { reading: "ご", euphonic: "regular" },
  名: { reading: "めい", euphonic: "regular" },
  両: { reading: "りょう", euphonic: "regular" },
  時: { reading: "じ", euphonic: "regular", numberByDigit: { 4: "よ", 7: "しち", 9: "く" } },
  // wago — take native numerals (ひと/ふた/み…) for 1–10
  晩: { reading: "ばん", euphonic: "wago" },
  間: { reading: "ま", euphonic: "wago" },
  切れ: { reading: "きれ", euphonic: "wago" },
  言: { reading: "こと", euphonic: "wago" },
};

// Suppletive combos, keyed `${value}${counter}`; these WIN over the rules.
// replacesRun: the numberReading spans the WHOLE number run (二十歳 → blank 二, はた on 十),
// vs ones-digit-only (十四日 → じゅうよっか, 十 keeps じゅう).
const IRREGULARS: Record<string, CounterReading> = {
  "1人": { numberReading: "ひと", counterReading: "り" },
  "2人": { numberReading: "ふた", counterReading: "り" },
  "20歳": { numberReading: "はた", counterReading: "ち", replacesRun: true },
  "20才": { numberReading: "はた", counterReading: "ち", replacesRun: true },
  // 日 series (number of days / day-of-month). 1–10 are single number tokens.
  "1日": { numberReading: "つい", counterReading: "たち" },
  "2日": { numberReading: "ふつ", counterReading: "か" },
  "3日": { numberReading: "みっ", counterReading: "か" },
  "4日": { numberReading: "よっ", counterReading: "か" },
  "5日": { numberReading: "いつ", counterReading: "か" },
  "6日": { numberReading: "むい", counterReading: "か" },
  "7日": { numberReading: "なの", counterReading: "か" },
  "8日": { numberReading: "よう", counterReading: "か" },
  "9日": { numberReading: "ここの", counterReading: "か" },
  "10日": { numberReading: "とお", counterReading: "か" },
  "14日": { numberReading: "よっ", counterReading: "か" }, // 十四日 → じゅうよっか
  "20日": { numberReading: "はつ", counterReading: "か", replacesRun: true }, // はつか
  "24日": { numberReading: "よっ", counterReading: "か" }, // 二十四日 → にじゅうよっか
};

// Numbers that geminate (→っ) before each class. h/k geminate on 6, s does not.
const GEMINATE: Record<Euphonic, ReadonlySet<number>> = {
  h: new Set([1, 6, 8, 10, 100]),
  k: new Set([1, 6, 8, 10, 100]),
  s: new Set([1, 8, 10]),
  wago: new Set(),
  regular: new Set(),
};

const GEMINATED_NUMBER: Record<number, string> = {
  1: "いっ", 6: "ろっ", 8: "はっ", 10: "じゅっ", 100: "ひゃっ",
};
const WAGO_NUMBER: Record<number, string> = {
  1: "ひと", 2: "ふた", 3: "み", 4: "よ", 5: "いつ", 6: "む", 7: "なな", 8: "や", 9: "ここの", 10: "とお",
};

// First-mora transforms on the counter reading.
const SEMIVOICED: Record<string, string> = { は: "ぱ", ひ: "ぴ", ふ: "ぷ", へ: "ぺ", ほ: "ぽ" }; // h gemination / pOn3
const VOICED_H: Record<string, string> = { は: "ば", ひ: "び", ふ: "ぶ", へ: "べ", ほ: "ぼ" }; // h rendaku
const VOICED_K: Record<string, string> = { か: "が", き: "ぎ", く: "ぐ", け: "げ", こ: "ご" }; // k rendaku
const VOICED_S: Record<string, string> = { さ: "ざ", し: "じ", す: "ず", せ: "ぜ", そ: "ぞ" }; // s rendaku

/** The digit that governs the euphonic change: ones place, or 10/100/1000 whole. */
function governingDigit(value: number): number {
  if (value === 100 || value === 1000) return value;
  if (value <= 10) return value;
  const ones = value % 10;
  return ones === 0 ? 10 : ones; // 20/30… behave like 十
}

function transformHead(reading: string, map: Record<string, string>): string {
  const v = map[reading[0]];
  return v ? v + reading.slice(1) : reading;
}

function resolveJa(value: number, counter: string): CounterReading | null {
  const irregular = IRREGULARS[`${value}${counter}`];
  if (irregular) return irregular;

  const info = COUNTERS[counter];
  if (!info) return null;

  const digit = governingDigit(value);
  const geminates = GEMINATE[info.euphonic].has(digit);

  // --- counter reading ---
  let counterReading = info.reading;
  if (info.euphonic === "h") {
    if (digit === 3 || digit === 1000) {
      counterReading = transformHead(info.reading, info.pOn3 ? SEMIVOICED : VOICED_H);
    } else if (geminates) {
      counterReading = transformHead(info.reading, SEMIVOICED);
    }
  } else if (info.euphonic === "k" && info.rendaku3 && digit === 3) {
    counterReading = transformHead(info.reading, VOICED_K);
  } else if (info.euphonic === "s" && info.rendaku3 && digit === 3) {
    counterReading = transformHead(info.reading, VOICED_S);
  }

  // --- number reading (of the last number token) ---
  let numberReading: string | null = null;
  if (info.numberByDigit && digit in info.numberByDigit) {
    numberReading = info.numberByDigit[digit];
  } else if (info.euphonic === "wago" && value <= 10) {
    numberReading = WAGO_NUMBER[digit] ?? null;
  } else if (geminates) {
    numberReading = GEMINATED_NUMBER[digit] ?? null;
  }

  return { numberReading, counterReading };
}

export const japaneseCounterResolver: CounterResolver = { resolve: resolveJa };

const KANJI_DIGIT: Record<string, number> = {
  〇: 0, 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};
const KANJI_UNIT: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };

/**
 * Parse a run of number-token surfaces into an integer: ASCII/full-width digits
 * (`3`, `１０`) or kanji numerals (三 → 3, 二十三 → 23, 百二十 → 120). Returns null on
 * anything it can't parse, so the caller skips the euphonic fix and keeps kuromoji's
 * reading. Scoped to 1..9999 — enough for counting; not a general number-to-kana.
 */
export function parseJapaneseNumber(surfaces: string[]): number | null {
  const s = surfaces.join("");
  if (/^[0-9]+$/.test(s)) return parseInt(s, 10);
  if (/^[０-９]+$/.test(s)) {
    return parseInt(s.replace(/[０-９]/g, (c) => String(c.charCodeAt(0) - 0xff10)), 10);
  }
  let section = 0;
  let current = 0;
  let seen = false;
  for (const ch of s) {
    if (ch in KANJI_DIGIT) {
      current = KANJI_DIGIT[ch];
      seen = true;
    } else if (ch in KANJI_UNIT) {
      section += (current === 0 ? 1 : current) * KANJI_UNIT[ch];
      current = 0;
      seen = true;
    } else {
      return null; // unknown character → bail
    }
  }
  return seen ? section + current : null;
}
