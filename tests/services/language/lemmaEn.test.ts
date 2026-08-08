import { describe, expect, it } from "vitest";
import {
  EN_IRREGULAR_EXCLUDED,
  englishLemma,
  readerLemma,
} from "@/services/language/lemmaEn";

describe("englishLemma — plural", () => {
  it("strips a regular plural", () => {
    expect(englishLemma("cats")).toBe("cat");
    expect(englishLemma("books")).toBe("book");
  });

  it("handles -ies", () => {
    expect(englishLemma("studies")).toBe("study");
    expect(englishLemma("cities")).toBe("city");
  });

  it("handles irregular plurals", () => {
    expect(englishLemma("children")).toBe("child");
    expect(englishLemma("mice")).toBe("mouse");
    expect(englishLemma("feet")).toBe("foot");
  });

  it("leaves -ss alone", () => {
    // glass/class/pass are not plurals; stripping invents "glas".
    for (const w of ["glass", "class", "pass", "dress"]) {
      expect(englishLemma(w)).toBeNull();
    }
  });

  it("leaves non-plural -s words alone", () => {
    for (const w of ["news", "series", "physics", "bus", "gas", "always"]) {
      expect(englishLemma(w)).toBeNull();
    }
  });
});

describe("englishLemma — verb tense", () => {
  it("maps irregular past/participles to the base", () => {
    expect(englishLemma("ran")).toBe("run");
    expect(englishLemma("ate")).toBe("eat");
    expect(englishLemma("written")).toBe("write");
    expect(englishLemma("went")).toBe("go");
  });

  it("maps 3rd-person -s", () => {
    expect(englishLemma("runs")).toBe("run");
  });

  it("maps -ied", () => {
    expect(englishLemma("studied")).toBe("study");
  });

  it("fixes the two wrong-word cases the reader actually produced", () => {
    // Measured before this module: sat → 特殊急襲部隊 (SAT, Special Assault Team) and
    // studied → わざとらしい (the adjective). Both are real entries for the spelling
    // and both are the wrong word for the sentence.
    expect(englishLemma("sat")).toBe("sit");
    expect(englishLemma("studied")).toBe("study");
  });
});

describe("englishLemma — declines rather than guess", () => {
  it("returns null for a base form", () => {
    for (const w of ["cat", "run", "study", "the"]) {
      expect(englishLemma(w)).toBeNull();
    }
  });

  it("does NOT touch regular -ing / -ed", () => {
    // No verifier to choose strip-3 vs strip-3+e, and -ing forms are often nouns in
    // their own right. The edge still lemmatizes these for LOOKUP.
    for (const w of ["running", "walking", "building", "meeting", "walked", "liked"]) {
      expect(englishLemma(w)).toBeNull();
    }
  });

  it("does NOT touch -es plurals", () => {
    // "buses"→bus and "cases"→case share the -ses ending; suffix alone can't split them.
    for (const w of ["buses", "cases", "boxes"]) {
      expect(englishLemma(w)).toBeNull();
    }
  });

  it("leaves every excluded irregular as written", () => {
    // Each is a common word on its own — mapping "left"→leave costs the direction sense.
    for (const w of EN_IRREGULAR_EXCLUDED) {
      expect(englishLemma(w)).toBeNull();
    }
  });

  it("ignores very short words", () => {
    for (const w of ["is", "as", "us", "an"]) {
      expect(englishLemma(w)).toBeNull();
    }
  });

  it("is case-insensitive and returns a lowercase dictionary key", () => {
    expect(englishLemma("Cats")).toBe("cat");
    expect(englishLemma("RAN")).toBe("run");
  });
});

describe("readerLemma — language gating", () => {
  it("applies only to English", () => {
    expect(readerLemma("cats", "EN")).toBe("cat");
    // JA has kuromoji; other languages have no rules and must stay as written.
    expect(readerLemma("cats", "JA")).toBeNull();
    expect(readerLemma("gatos", "ES")).toBeNull();
  });
});
