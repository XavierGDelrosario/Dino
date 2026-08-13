// =========================================================
// THE CROSS-RUNTIME PIN for the English POS tagger.
//
// The model is trained in Python (scripts/build-pos-tagger.py) and run in TypeScript
// (services/language/posEn.ts). Those are two hand-written copies of one feature
// function, and the failure mode when they drift is SILENT: no error, no exception,
// just quietly worse tags against weights that no longer describe the same feature
// space. So the trainer emits a golden fixture — real sentences from the held-out TEST
// split, tagged by the trainer itself — and this replays them through the TypeScript
// tagger and demands an exact match.
//
// If this fails after you touch either feature function, the two have diverged. Fix the
// mirror; do NOT regenerate the fixture to make it pass — regenerating hides exactly the
// bug it exists to catch. Regenerate only when the model is deliberately retrained.
// Same discipline as tests/services/projection-version.test.ts.
// =========================================================
import { describe, it, expect } from "vitest";
import golden from "@/../tests/fixtures/pos-en-golden.json";
import model from "@/services/language/posEnModel.json";
import { tagWithModel, __internal } from "@/services/language/posEn";

type GoldenCase = { words: string[]; tags: string[] };
const cases = golden as GoldenCase[];

// The JSON import is structurally `{tags, scale, tagdict, weights}`; the runtime's
// PosModel type is not exported, so cast once here rather than in every assertion.
const MODEL = model as unknown as Parameters<typeof tagWithModel>[0];

describe("English POS tagger — trainer/runtime agreement", () => {
  it("the fixture is present and non-trivial", () => {
    expect(cases.length).toBeGreaterThan(20);
    expect(cases.every((c) => c.words.length === c.tags.length)).toBe(true);
  });

  it("reproduces the trainer's tags EXACTLY on every golden sentence", () => {
    const mismatches: string[] = [];
    for (const c of cases) {
      const got = tagWithModel(MODEL, c.words);
      if (got.join(" ") !== c.tags.join(" ")) {
        for (let i = 0; i < c.words.length; i++) {
          if (got[i] !== c.tags[i]) {
            mismatches.push(`"${c.words[i]}" expected ${c.tags[i]}, got ${got[i]} in: ${c.words.join(" ")}`);
          }
        }
      }
    }
    expect(mismatches).toEqual([]);
  });
});

describe("English POS tagger — the feature primitives", () => {
  const { normalize, shape } = __internal;

  // These mirror Python's str.isdigit / isupper / islower semantics, which are not the
  // same as the obvious JS one-liners — the comments in posEn.ts explain why. Pinning
  // them directly means a regression here names the primitive instead of surfacing as
  // an inscrutable tag mismatch above.
  it("normalize collapses hyphens, years and digit strings", () => {
    expect(normalize("mother-in-law")).toBe("!HYPHEN");
    expect(normalize("-5")).toBe("-5"); // leading hyphen is NOT the hyphen class
    expect(normalize("2026")).toBe("!YEAR");
    expect(normalize("42")).toBe("!DIGITS");
    expect(normalize("Cats")).toBe("cats");
  });

  it("shape separates the capitalisation classes PROPN depends on", () => {
    expect(shape("UEFA")).toBe("XX");
    expect(shape("Abidal")).toBe("Xx");
    expect(shape("forces")).toBe("xx");
    expect(shape("iPhone")).toBe("mixed");
    expect(shape("2026")).toBe("d");
    expect(shape("")).toBe("");
  });

  it("a caseless token is neither upper nor lower (Python parity)", () => {
    // "!!!" has no cased characters, so Python's isupper() and islower() are both
    // False and it falls through to "mixed". A naive `w === w.toUpperCase()` would
    // wrongly call it XX and shift every downstream feature.
    expect(shape("!!!")).toBe("mixed");
  });
});

describe("English POS tagger — what it is FOR", () => {
  // Not accuracy tests (the trainer measures that on a held-out split); these pin the
  // specific distinction the feature exists to make, so a retrain that regressed it
  // would be caught here rather than in production.
  it("tags a mid-sentence name as PROPN but a sentence-initial common noun as a noun", () => {
    const propn = tagWithModel(MODEL, ["The", "striker", "Abidal", "scored", "again"]);
    expect(propn[2]).toBe("PROPN");

    const common = tagWithModel(MODEL, ["Cats", "sleep", "all", "day"]);
    expect(common[0]).not.toBe("PROPN");
  });

  // Real context disambiguation, verified against the shipped weights. These are the
  // homographs the training data actually supports; each pair differs ONLY in context,
  // so passing them means the tagger is reading the sentence and not the surface.
  it.each([
    [["I", "like", "strong", "coffee"], 1, "VERB"],
    [["It", "looks", "like", "rain", "today"], 2, "SCONJ"],
    [["He", "read", "a", "good", "book"], 4, "NOUN"],
    [["I", "will", "book", "a", "table"], 2, "VERB"],
    [["My", "back", "hurts", "badly"], 1, "NOUN"],
    [["He", "walked", "back", "home"], 2, "ADV"],
  ] as [string[], number, string][])(
    "reads %j token %i as %s",
    (words, index, expected) => {
      expect(tagWithModel(MODEL, words)[index]).toBe(expected);
    },
  );

  // ‼️ THE LIMIT, PINNED SO IT IS NOT MISREAD AS A BUG. docs/TODO.md framed this feature
  // as "tell the modal `can` from the noun `can`". This tagger does NOT do that, and no
  // amount of tuning would: UD English-EWT contains `can` 583 times, 578 AUX against 5
  // NOUN, so both the tag dictionary and the model correctly learn that `can` is
  // essentially always an auxiliary. It is a gap in the TREEBANK, not in the features.
  // Fixing it needs training data with the noun sense, not a different model.
  it("does NOT resolve 'can' — a training-data limit, not a tuning one", () => {
    expect(tagWithModel(MODEL, ["He", "opened", "a", "can", "of", "soup"])[3]).toBe("AUX");
  });

  // The property the demotion policy actually rests on: a sentence-initial capitalised
  // common noun must not be called PROPN. (It happens to come back VERB here rather
  // than NOUN — an ordinary tagging miss, and harmless, because every content tag
  // leaves the word addable. PROPN is the only tag that removes it.)
  it("never demotes a sentence-initial common noun, even when it mis-tags it", () => {
    const tags = tagWithModel(MODEL, ["Cats", "sleep", "all", "day"]);
    expect(tags[0]).not.toBe("PROPN");
  });
});
