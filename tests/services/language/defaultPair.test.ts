// @vitest-environment jsdom
// The pair a user opens on when they have saved none (or half of one): native is the
// device's language, learning is the other supported one. A saved value always wins.
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  defaultLanguagePair,
  otherLanguage,
  resolveLanguagePair,
  systemLanguage,
} from "@/services/language";

const device = (...langs: string[]) => {
  vi.spyOn(navigator, "languages", "get").mockReturnValue(langs);
  vi.spyOn(navigator, "language", "get").mockReturnValue(langs[0] ?? "");
};
afterEach(() => vi.restoreAllMocks());

describe("systemLanguage", () => {
  it("reads the device's first language as a supported code", () => {
    device("ja-JP", "en-US");
    expect(systemLanguage()).toBe("JA");
    device("en-GB");
    expect(systemLanguage()).toBe("EN");
  });

  it("is null for a language the app doesn't support", () => {
    device("es-ES");
    expect(systemLanguage()).toBeNull();
  });
});

describe("otherLanguage", () => {
  it("is the other of the two supported languages", () => {
    expect(otherLanguage("JA")).toBe("EN");
    expect(otherLanguage("EN")).toBe("JA");
  });
});

describe("defaultLanguagePair", () => {
  it("a Japanese device learns English, explained in Japanese", () => {
    device("ja-JP");
    expect(defaultLanguagePair()).toEqual({ native: "JA", learning: "EN" });
  });

  it("an English device learns Japanese", () => {
    device("en-US");
    expect(defaultLanguagePair()).toEqual({ native: "EN", learning: "JA" });
  });

  it("an unsupported device language falls back to English native, Japanese to learn", () => {
    device("fr-FR");
    expect(defaultLanguagePair()).toEqual({ native: "EN", learning: "JA" });
  });
});

describe("resolveLanguagePair", () => {
  it("a fully saved pair is used as-is, whatever the device says", () => {
    device("ja-JP");
    expect(resolveLanguagePair({ learningLanguage: "JA", nativeLanguage: "EN" })).toEqual({
      native: "EN",
      learning: "JA",
    });
  });

  it("nothing saved → the device's default pair", () => {
    device("ja-JP");
    expect(resolveLanguagePair({ learningLanguage: null, nativeLanguage: null })).toEqual({
      native: "JA",
      learning: "EN",
    });
    expect(resolveLanguagePair(null)).toEqual({ native: "JA", learning: "EN" });
  });

  it("only native saved → learning is the other one", () => {
    device("en-US");
    expect(resolveLanguagePair({ learningLanguage: null, nativeLanguage: "JA" })).toEqual({
      native: "JA",
      learning: "EN",
    });
  });

  it("only learning saved → native is the device's language, never the same language twice", () => {
    device("ja-JP");
    expect(resolveLanguagePair({ learningLanguage: "EN", nativeLanguage: null })).toEqual({
      native: "JA",
      learning: "EN",
    });
    // The device's language IS the one being learned → native must be the other.
    expect(resolveLanguagePair({ learningLanguage: "JA", nativeLanguage: null })).toEqual({
      native: "EN",
      learning: "JA",
    });
  });
});
