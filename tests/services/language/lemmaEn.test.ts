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

describe("englishLemma — possessives", () => {
  it("strips 's rather than reading it as a plural", () => {
    // The bug this replaced: the -s rule fired on the `s` and left the apostrophe
    // ("europe's" → "europe'"), a form no dictionary can match — and one that still
    // has a letter, so the server pays Google for it and caches the junk.
    expect(englishLemma("europe's")).toBe("europe");
    expect(englishLemma("world's")).toBe("world");
    expect(englishLemma("putin's")).toBe("putin");
  });

  it("re-lemmatizes the stem", () => {
    expect(englishLemma("children's")).toBe("child");
    expect(englishLemma("cities'")).toBe("city");
  });

  it("keeps a stem no other rule touches, instead of giving up on it", () => {
    // Returning null here would look the token up as written — apostrophe and all.
    expect(englishLemma("boss's")).toBe("boss");
    expect(englishLemma("boss'")).toBe("boss");
  });

  it("resolves a plural possessive through the plural rule", () => {
    expect(englishLemma("workers'")).toBe("worker");
    expect(englishLemma("students'")).toBe("student");
  });

  it("reads a curly apostrophe as the same thing", () => {
    expect(englishLemma("europe’s")).toBe("europe");
    expect(englishLemma("workers’")).toBe("worker");
  });

  it("leaves a word-internal apostrophe alone", () => {
    // Only a TRAILING marker is a possessive; o'clock is one word, and n't
    // contractions are closed-class words the reader never looks up anyway.
    expect(englishLemma("o'clock")).toBeNull();
    expect(englishLemma("don't")).toBeNull();
  });

  it("never returns a bare apostrophe or an empty key", () => {
    for (const w of ["'s", "''", "'"]) expect(englishLemma(w)).toBeNull();
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

describe("englishLemma — the WordNet long tail (irregularsEn.generated)", () => {
  it("resolves irregulars the hand map never listed", () => {
    expect(englishLemma("aardwolves")).toBe("aardwolf");
    expect(englishLemma("abaci")).toBe("abacus");
    expect(englishLemma("criteria")).toBe("criterion");
    expect(englishLemma("phenomena")).toBe("phenomenon");
    expect(englishLemma("crises")).toBe("crisis");
  });

  it("resolves the doubled-consonant forms the rules deliberately refuse to guess", () => {
    // The header defers regular -ing/-ed because strip-3 vs strip-3+e needs a verifier.
    // WordNet names the base outright, so there is nothing left to guess.
    expect(englishLemma("abetted")).toBe("abet");
    expect(englishLemma("abhorring")).toBe("abhor");
  });

  it("still honours EN_IRREGULAR_EXCLUDED, which the generator alone would not catch", () => {
    // WordNet lists met→meet and meant→mean, and does NOT carry either surface as a
    // lemma — so only the curated set keeps them unresolved. This is the regression
    // guard for the whole exclusion mechanism.
    expect(englishLemma("met")).toBeNull();
    expect(englishLemma("meant")).toBeNull();
  });

  it("holds back entries whose surface is a word in its own right", () => {
    // Dropped at BUILD time. "fungi" and "rose" are WordNet lemmas themselves, so the
    // reader leaves them as written even though the exception list maps them; "axes"
    // has two bases (ax, axis) and there is no verifier here to choose.
    expect(englishLemma("fungi")).toBeNull();
    expect(englishLemma("rose")).toBeNull();
    expect(englishLemma("axes")).not.toBe("ax");
    expect(englishLemma("axes")).not.toBe("axis");
  });

  it("holds back a plural that is also somebody's -s form, but not its neighbours", () => {
    // «he lives in Tokyo» must not answer "life". WordNet lists lives→life and knows no
    // verb reading, so the build rule checks the stripped stem instead: `live`, `shelve`
    // and `halve` are real verbs, so those three are held back — while `wolves` and
    // `knives` keep resolving, there being no verb `wolve` or `knive`.
    for (const w of ["lives", "shelves", "halves", "calves", "thieves"]) {
      expect(englishLemma(w)).toBeNull();
    }
    expect(englishLemma("wolves")).toBe("wolf");
    expect(englishLemma("knives")).toBe("knife");
  });

  it("keeps the curated map ahead of the generated one", () => {
    // WordNet has no entry for these at all; they must not regress to null.
    expect(englishLemma("women")).toBe("woman");
    expect(englishLemma("children")).toBe("child");
  });
});

describe("englishLemma — keys that are Object.prototype members", () => {
  it("treats 'constructor' as the ordinary English word it is", () => {
    // A constructor is a builder, and WordNet lists it. Because the irregular maps are
    // object literals, `EN_IRREGULARS["constructor"]` used to return a FUNCTION, which
    // this returned as if it were a lemma.
    expect(englishLemma("constructor")).toBeNull();
    expect(englishLemma("constructors")).toBe("constructor");
  });

  it("survives every other inherited key", () => {
    for (const w of ["valueOf", "toString", "isPrototypeOf", "hasOwnProperty", "__proto__"]) {
      expect(typeof englishLemma(w)).not.toBe("function");
    }
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
