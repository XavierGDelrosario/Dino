import { describe, it, expect } from "vitest";
import { partOfSpeechCategory } from "@/services/language/partOfSpeech";

describe("partOfSpeechCategory", () => {
  it("returns null for null/empty POS", () => {
    expect(partOfSpeechCategory(null)).toBeNull();
    expect(partOfSpeechCategory(undefined)).toBeNull();
    expect(partOfSpeechCategory([])).toBeNull();
  });

  it("maps every godan/ichidan/irregular verb class to 'verb'", () => {
    for (const code of ["v1", "v5r", "v5k-s", "vk", "vs-i", "vz", "vn"]) {
      expect(partOfSpeechCategory([code])).toBe("verb");
    }
  });

  it("maps transitivity-only codes (vi/vt) to 'verb'", () => {
    expect(partOfSpeechCategory(["vt"])).toBe("verb");
    expect(partOfSpeechCategory(["vi"])).toBe("verb");
  });

  it("maps noun families to 'noun' but 'num' to 'numeric' (not swallowed by the n-prefix)", () => {
    expect(partOfSpeechCategory(["n"])).toBe("noun");
    expect(partOfSpeechCategory(["n-adv"])).toBe("noun");
    expect(partOfSpeechCategory(["n-pr"])).toBe("noun");
    expect(partOfSpeechCategory(["num"])).toBe("numeric");
  });

  it("maps adjective families to 'adjective' but adj-pn to 'determiner'", () => {
    expect(partOfSpeechCategory(["adj-i"])).toBe("adjective");
    expect(partOfSpeechCategory(["adj-na"])).toBe("adjective");
    expect(partOfSpeechCategory(["adj-no"])).toBe("adjective");
    expect(partOfSpeechCategory(["adj-pn"])).toBe("determiner");
  });

  it("maps adverbs, and does not confuse adv/aux with the verb prefix", () => {
    expect(partOfSpeechCategory(["adv"])).toBe("adverb");
    expect(partOfSpeechCategory(["adv-to"])).toBe("adverb");
    expect(partOfSpeechCategory(["aux-v"])).toBe("auxiliary");
    expect(partOfSpeechCategory(["cop"])).toBe("auxiliary");
  });

  it("maps the remaining closed classes", () => {
    expect(partOfSpeechCategory(["pn"])).toBe("pronoun");
    expect(partOfSpeechCategory(["prt"])).toBe("particle");
    expect(partOfSpeechCategory(["conj"])).toBe("conjunction");
    expect(partOfSpeechCategory(["int"])).toBe("interjection");
    expect(partOfSpeechCategory(["ctr"])).toBe("counter");
    expect(partOfSpeechCategory(["pref"])).toBe("prefix");
    expect(partOfSpeechCategory(["suf"])).toBe("suffix");
    expect(partOfSpeechCategory(["exp"])).toBe("expression");
  });

  it("returns the FIRST recognised category (word class before modifiers)", () => {
    // JMdict orders the word-class code ahead of transitivity: ["v5r","vt"] → verb.
    expect(partOfSpeechCategory(["v5r", "vt"])).toBe("verb");
    // An unrecognised leading code is skipped in favour of the next known one.
    expect(partOfSpeechCategory(["unc", "n"])).toBe("noun");
  });

  it("returns null when no code is recognised", () => {
    expect(partOfSpeechCategory(["unc", "xyz"])).toBeNull();
  });
});
