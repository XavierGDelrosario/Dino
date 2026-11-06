// @vitest-environment jsdom
// The pair a user opens on when they have saved none (or half of one): native is the
// device's language, learning is a LEARNABLE language other than it (Japanese only, as
// of 2026-11-07). A saved native wins unless it collides; a saved learning language
// wins only while it is still learnable.
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  defaultLanguagePair,
  isLearnable,
  learningOptions,
  nativeOptions,
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

describe("learnable languages", () => {
  it("only Japanese can be studied for now; English stays a native/translate language", () => {
    expect(isLearnable("JA")).toBe(true);
    expect(isLearnable("EN")).toBe(false);
    expect(learningOptions().map((l) => l.code)).toEqual(["JA"]);
  });

  it("the native dropdown never offers the language being learned", () => {
    expect(nativeOptions("JA").map((l) => l.code)).toEqual(["EN"]);
  });
});

describe("defaultLanguagePair", () => {
  it("a Japanese device still learns Japanese (explained in English)", () => {
    device("ja-JP");
    expect(defaultLanguagePair()).toEqual({ native: "EN", learning: "JA" });
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
  it("a fully saved (learnable) pair is used as-is, whatever the device says", () => {
    device("ja-JP");
    expect(resolveLanguagePair({ learningLanguage: "JA", nativeLanguage: "EN" })).toEqual({
      native: "EN",
      learning: "JA",
    });
  });

  it("a saved pair learning a no-longer-learnable language reads as learning Japanese", () => {
    device("ja-JP");
    expect(resolveLanguagePair({ learningLanguage: "EN", nativeLanguage: "JA" })).toEqual({
      native: "EN",
      learning: "JA",
    });
  });

  it("nothing saved → the device's default pair", () => {
    device("ja-JP");
    expect(resolveLanguagePair({ learningLanguage: null, nativeLanguage: null })).toEqual({
      native: "EN",
      learning: "JA",
    });
    expect(resolveLanguagePair(null)).toEqual({ native: "EN", learning: "JA" });
  });

  it("only native saved → learning is a learnable language, never the same one twice", () => {
    device("en-US");
    expect(resolveLanguagePair({ learningLanguage: null, nativeLanguage: "EN" })).toEqual({
      native: "EN",
      learning: "JA",
    });
    expect(resolveLanguagePair({ learningLanguage: null, nativeLanguage: "JA" })).toEqual({
      native: "EN",
      learning: "JA",
    });
  });

  it("only learning saved → native is the device's language, never the same language twice", () => {
    device("en-US");
    expect(resolveLanguagePair({ learningLanguage: "JA", nativeLanguage: null })).toEqual({
      native: "EN",
      learning: "JA",
    });
    // The device's language IS the one being learned → native must be the other.
    device("ja-JP");
    expect(resolveLanguagePair({ learningLanguage: "JA", nativeLanguage: null })).toEqual({
      native: "EN",
      learning: "JA",
    });
  });
});
