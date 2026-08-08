import { describe, expect, it } from "vitest";
import {
  MAX_HISTORY,
  entryKey,
  pushEntry,
  type TranslateHistoryEntry,
} from "@/services/translateHistory";

const entry = (
  text: string,
  source: string = "JA",
  target: string = "EN",
): TranslateHistoryEntry =>
  ({ text, source, target } as TranslateHistoryEntry);

describe("translate history — pushEntry", () => {
  it("puts the newest submission first", () => {
    const list = pushEntry(pushEntry([], entry("猫")), entry("犬"));
    expect(list.map((e) => e.text)).toEqual(["犬", "猫"]);
  });

  it("moves a re-translated entry to the front instead of duplicating it", () => {
    // Re-translating the same phrase is normal during a study session; without
    // this the row fills with one repeated string and stops being useful.
    let list = pushEntry([], entry("猫"));
    list = pushEntry(list, entry("犬"));
    list = pushEntry(list, entry("猫"));
    expect(list.map((e) => e.text)).toEqual(["猫", "犬"]);
    expect(list).toHaveLength(2);
  });

  it("keeps the same text as separate entries per direction", () => {
    // 愛 JA→EN and 愛 ZH→EN are different lookups; collapsing them would replay a
    // translation the user never asked for.
    let list = pushEntry([], entry("愛", "JA", "EN"));
    list = pushEntry(list, entry("愛", "ZH", "EN"));
    expect(list).toHaveLength(2);
    expect(entryKey(list[0])).not.toBe(entryKey(list[1]));
  });

  it("treats a differing TARGET as a separate entry too", () => {
    let list = pushEntry([], entry("猫", "JA", "EN"));
    list = pushEntry(list, entry("猫", "JA", "ZH"));
    expect(list).toHaveLength(2);
  });

  it("caps the list, dropping the oldest", () => {
    let list: TranslateHistoryEntry[] = [];
    for (let i = 0; i < MAX_HISTORY + 5; i++) list = pushEntry(list, entry(`w${i}`));
    expect(list).toHaveLength(MAX_HISTORY);
    expect(list[0].text).toBe(`w${MAX_HISTORY + 4}`); // newest kept
    expect(list.some((e) => e.text === "w0")).toBe(false); // oldest dropped
  });

  it("honours an explicit cap", () => {
    let list: TranslateHistoryEntry[] = [];
    for (const w of ["a", "b", "c"]) list = pushEntry(list, entry(w), 2);
    expect(list.map((e) => e.text)).toEqual(["c", "b"]);
  });

  it("trims the stored text", () => {
    const [only] = pushEntry([], entry("  猫  "));
    expect(only.text).toBe("猫");
  });

  it("drops blank input rather than storing an unusable chip", () => {
    expect(pushEntry([], entry("   "))).toEqual([]);
    expect(pushEntry([entry("猫")], entry(""))).toHaveLength(1);
  });

  it("does not mutate the list it is given (it is React state)", () => {
    const original = [entry("猫")];
    const frozen = Object.freeze([...original]);
    const next = pushEntry(frozen, entry("犬"));
    expect(original).toHaveLength(1);
    expect(next).toHaveLength(2);
    expect(next).not.toBe(frozen);
  });

  it("dedupes on trimmed text, so re-submitting with stray spaces still moves", () => {
    let list = pushEntry([], entry("猫"));
    list = pushEntry(list, entry("犬"));
    list = pushEntry(list, entry("  猫 "));
    expect(list.map((e) => e.text)).toEqual(["猫", "犬"]);
  });
});
