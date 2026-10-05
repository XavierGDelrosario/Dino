import { describe, it, expect } from "vitest";
import { nameRomaji } from "@/services/language/romaji";

describe("nameRomaji — a kana reading as a romanized name", () => {
  it("romanizes everyday surnames", () => {
    expect(nameRomaji("たなか")).toBe("Tanaka");
    expect(nameRomaji("はやし")).toBe("Hayashi");
    expect(nameRomaji("すずき")).toBe("Suzuki");
    expect(nameRomaji("まつもと")).toBe("Matsumoto");
  });

  it("collapses long vowels the way names are written", () => {
    expect(nameRomaji("さとう")).toBe("Sato");
    expect(nameRomaji("おおたに")).toBe("Otani");
    expect(nameRomaji("ゆうき")).toBe("Yuki");
    expect(nameRomaji("とうきょう")).toBe("Tokyo");
  });

  it("handles contracted sounds, doubled consonants and ん", () => {
    expect(nameRomaji("しょうへい")).toBe("Shohei");
    expect(nameRomaji("きょうこ")).toBe("Kyoko");
    expect(nameRomaji("じゅん")).toBe("Jun");
    expect(nameRomaji("はっとり")).toBe("Hattori");
    expect(nameRomaji("まっちゃ")).toBe("Matcha");
    expect(nameRomaji("けんいち")).toBe("Ken'ichi");
    expect(nameRomaji("しんや")).toBe("Shin'ya");
  });

  it("takes katakana too", () => {
    expect(nameRomaji("トヨタ")).toBe("Toyota");
    expect(nameRomaji("ソニー")).toBe("Soni"); // why a company prefers a translation
  });

  it("is null rather than half-converted when it isn't kana", () => {
    expect(nameRomaji("田中")).toBeNull();
    expect(nameRomaji("")).toBeNull();
    expect(nameRomaji(null)).toBeNull();
  });
});
