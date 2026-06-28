import { describe, it, expect } from "vitest";
import {
  japaneseCounterResolver,
  parseJapaneseNumber,
} from "@/services/language/counters";

const r = (value: number, counter: string) => japaneseCounterResolver.resolve(value, counter);

describe("japaneseCounterResolver — h-row (本/杯/匹)", () => {
  it("半濁音 on gemination (1/6/8/10/100 → っ + ぽん)", () => {
    expect(r(1, "本")).toEqual({ numberReading: "いっ", counterReading: "ぽん" });
    expect(r(6, "本")).toEqual({ numberReading: "ろっ", counterReading: "ぽん" });
    expect(r(8, "本")).toEqual({ numberReading: "はっ", counterReading: "ぽん" });
    expect(r(10, "本")).toEqual({ numberReading: "じゅっ", counterReading: "ぽん" });
    expect(r(100, "本")).toEqual({ numberReading: "ひゃっ", counterReading: "ぽん" });
  });
  it("連濁 on 3 → ぼん/ばい/びき; no number change", () => {
    expect(r(3, "本")).toEqual({ numberReading: null, counterReading: "ぼん" });
    expect(r(3, "杯")).toEqual({ numberReading: null, counterReading: "ばい" });
    expect(r(3, "匹")).toEqual({ numberReading: null, counterReading: "びき" });
  });
  it("plain on the unchanged numbers (2/4/5/7/9 → ほん)", () => {
    expect(r(2, "本")).toEqual({ numberReading: null, counterReading: "ほん" });
    expect(r(5, "本")).toEqual({ numberReading: null, counterReading: "ほん" });
  });
});

describe("japaneseCounterResolver — k-row (個/階/軒)", () => {
  it("geminates the number, counter stays (十個 → じゅっこ)", () => {
    expect(r(1, "個")).toEqual({ numberReading: "いっ", counterReading: "こ" });
    expect(r(10, "個")).toEqual({ numberReading: "じゅっ", counterReading: "こ" });
    expect(r(8, "階")).toEqual({ numberReading: "はっ", counterReading: "かい" });
  });
  it("rendaku on 3 ONLY for flagged counters (階→がい, 軒→げん; 個 stays こ)", () => {
    expect(r(3, "階")).toEqual({ numberReading: null, counterReading: "がい" });
    expect(r(3, "軒")).toEqual({ numberReading: null, counterReading: "げん" });
    expect(r(3, "個")).toEqual({ numberReading: null, counterReading: "こ" });
  });
});

describe("japaneseCounterResolver — s-row (冊/歳)", () => {
  it("geminates on 1/8/10 but NOT 6, counter unchanged", () => {
    expect(r(1, "冊")).toEqual({ numberReading: "いっ", counterReading: "さつ" });
    expect(r(8, "冊")).toEqual({ numberReading: "はっ", counterReading: "さつ" });
    expect(r(6, "冊")).toEqual({ numberReading: null, counterReading: "さつ" }); // 六冊 = ろくさつ
    expect(r(3, "冊")).toEqual({ numberReading: null, counterReading: "さつ" }); // no rendaku
  });
});

describe("japaneseCounterResolver — pOn3 (分/泊/歩) take p not b on 3", () => {
  it("三分→さんぷん, 三歩→さんぽ, 三泊→さんぱく (semivoiced, no number gemination)", () => {
    expect(r(3, "分")).toEqual({ numberReading: null, counterReading: "ぷん" });
    expect(r(3, "歩")).toEqual({ numberReading: null, counterReading: "ぽ" });
    expect(r(3, "泊")).toEqual({ numberReading: null, counterReading: "ぱく" });
  });
  it("still geminate normally (一分いっぷん, 六分ろっぷん)", () => {
    expect(r(1, "分")).toEqual({ numberReading: "いっ", counterReading: "ぷん" });
    expect(r(6, "分")).toEqual({ numberReading: "ろっ", counterReading: "ぷん" });
  });
});

describe("japaneseCounterResolver — s-row rendaku3 (足→ぞく) + geminating t/ch counters", () => {
  it("三足→さんぞく; 一足いっそく", () => {
    expect(r(3, "足")).toEqual({ numberReading: null, counterReading: "ぞく" });
    expect(r(1, "足")).toEqual({ numberReading: "いっ", counterReading: "そく" });
  });
  it("頭/着/通/点 geminate like s (一頭いっとう, 一着いっちゃく)", () => {
    expect(r(1, "頭")).toEqual({ numberReading: "いっ", counterReading: "とう" });
    expect(r(1, "着")).toEqual({ numberReading: "いっ", counterReading: "ちゃく" });
    expect(r(3, "頭")).toEqual({ numberReading: null, counterReading: "とう" });
  });
});

describe("japaneseCounterResolver — 時 per-digit number readings", () => {
  it("四時よじ, 七時しちじ, 九時くじ; 一時いちじ unchanged", () => {
    expect(r(4, "時")).toEqual({ numberReading: "よ", counterReading: "じ" });
    expect(r(7, "時")).toEqual({ numberReading: "しち", counterReading: "じ" });
    expect(r(9, "時")).toEqual({ numberReading: "く", counterReading: "じ" });
    expect(r(1, "時")).toEqual({ numberReading: null, counterReading: "じ" });
  });
  it("compounds use the ones digit (十四時 → じゅうよじ via 4→よ)", () => {
    expect(r(14, "時")).toEqual({ numberReading: "よ", counterReading: "じ" });
  });
});

describe("japaneseCounterResolver — wago counters (native numerals 1–10)", () => {
  it("一晩ひとばん, 二間ふたま, 三晩みばん (counter unchanged)", () => {
    expect(r(1, "晩")).toEqual({ numberReading: "ひと", counterReading: "ばん" });
    expect(r(2, "間")).toEqual({ numberReading: "ふた", counterReading: "ま" });
    expect(r(3, "晩")).toEqual({ numberReading: "み", counterReading: "ばん" });
  });
  it("above 10 reverts to kango (leave the number; 十一晩 → じゅういちばん)", () => {
    expect(r(11, "晩")).toEqual({ numberReading: null, counterReading: "ばん" });
  });
});

describe("japaneseCounterResolver — 日 series + 二十歳 (suppletive)", () => {
  it("ついたち…とおか", () => {
    expect(r(1, "日")).toEqual({ numberReading: "つい", counterReading: "たち" });
    expect(r(8, "日")).toEqual({ numberReading: "よう", counterReading: "か" });
    expect(r(10, "日")).toEqual({ numberReading: "とお", counterReading: "か" });
  });
  it("はつか (二十日) and 十四日 span differently (replacesRun)", () => {
    expect(r(20, "日")).toEqual({ numberReading: "はつ", counterReading: "か", replacesRun: true });
    expect(r(14, "日")).toEqual({ numberReading: "よっ", counterReading: "か" }); // ones-digit only
  });
  it("二十歳 → はたち spans the whole number run", () => {
    expect(r(20, "歳")).toEqual({ numberReading: "はた", counterReading: "ち", replacesRun: true });
  });
});

describe("japaneseCounterResolver — regular + irregular", () => {
  it("regular counters never change (枚/人>2)", () => {
    expect(r(1, "枚")).toEqual({ numberReading: null, counterReading: "まい" });
    expect(r(3, "人")).toEqual({ numberReading: null, counterReading: "にん" });
  });
  it("jukujikun irregulars win (一人ひとり, 二人ふたり)", () => {
    expect(r(1, "人")).toEqual({ numberReading: "ひと", counterReading: "り" });
    expect(r(2, "人")).toEqual({ numberReading: "ふた", counterReading: "り" });
  });
  it("compound numbers use the governing ones-digit (16本 → ろっぽん, 23冊 → さつ)", () => {
    expect(r(16, "本")).toEqual({ numberReading: "ろっ", counterReading: "ぽん" });
    expect(r(23, "冊")).toEqual({ numberReading: null, counterReading: "さつ" });
    expect(r(20, "個")).toEqual({ numberReading: "じゅっ", counterReading: "こ" }); // にじゅっこ
  });
  it("returns null for an unknown counter (leave kuromoji's reading)", () => {
    expect(r(3, "冠")).toBeNull();
  });
});

describe("parseJapaneseNumber", () => {
  it("kanji numerals", () => {
    expect(parseJapaneseNumber(["六"])).toBe(6);
    expect(parseJapaneseNumber(["十"])).toBe(10);
    expect(parseJapaneseNumber(["二", "十", "三"])).toBe(23);
    expect(parseJapaneseNumber(["百", "二", "十"])).toBe(120);
    expect(parseJapaneseNumber(["千"])).toBe(1000);
  });
  it("ASCII + full-width digits", () => {
    expect(parseJapaneseNumber(["3"])).toBe(3);
    expect(parseJapaneseNumber(["1", "0"])).toBe(10);
    expect(parseJapaneseNumber(["１２"])).toBe(12);
  });
  it("returns null for unparseable input", () => {
    expect(parseJapaneseNumber(["本"])).toBeNull();
    expect(parseJapaneseNumber([])).toBeNull();
  });
});
