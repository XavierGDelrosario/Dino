// The session vocabulary cache: a list is a filter over ALL, confidence is re-derived
// at READ time (it decays), write-through keeps it current, and a background re-check
// never clobbers a write that landed while it was in flight.
import { describe, it, expect, beforeEach } from "vitest";
import { makeUserWord } from "@test/fixtures";
import * as vocab from "@/services/words/vocabularyCache";

const U = "user-1";
const DAY = 86_400_000;

function load(words = [makeUserWord({ userWordId: "a" }), makeUserWord({ userWordId: "b" })]) {
  vocab.vocabularyStore(U);
  vocab.appendPage(U, words);
  vocab.markComplete(U);
  vocab.setMembership(U, [{ listId: "L", userWordId: "a" }]);
  vocab.setLists(U, [{ listId: "L", listName: "L" }]);
}

beforeEach(() => vocab.resetVocabulary());

describe("vocabularyCache", () => {
  it("serves a list as a filter over ALL, in ALL's order", () => {
    load();
    expect(vocab.wordsFor(U, null).map((w) => w.userWordId)).toEqual(["a", "b"]);
    expect(vocab.wordsFor(U, "L").map((w) => w.userWordId)).toEqual(["a"]);
    expect(vocab.isFresh(U)).toBe(true);
  });

  it("re-derives confidence at read time, so a cached word still decays", () => {
    const reviewed = new Date(0).toISOString();
    load([makeUserWord({
      userWordId: "a",
      confidenceRating: 5,
      confidenceInputs: { stability: 40, lastReviewedDate: reviewed, originallyTranslatedDate: reviewed,
        shortStability: null, shortStabilityAt: null, peakConfidence: 0 },
    })]);
    const soon = vocab.wordsFor(U, null, Date.parse(reviewed) + DAY)[0].confidenceRating;
    const later = vocab.wordsFor(U, null, Date.parse(reviewed) + 400 * DAY)[0].confidenceRating;
    expect(later).toBeLessThan(soon);
  });

  it("a re-save keeps the cached copy (the save response is the thinner one); an edit patches it", () => {
    load([makeUserWord({ userWordId: "a", translation: "my meaning", example: "例文" })]);
    vocab.writeWords(U, [makeUserWord({ userWordId: "a", translation: "dictionary", example: null })]);
    expect(vocab.wordsFor(U, null)[0]).toMatchObject({ translation: "my meaning", example: "例文" });
    vocab.writeWordById("a", makeUserWord({ userWordId: "a", translation: "edited" }));
    expect(vocab.wordsFor(U, null)[0].translation).toBe("edited");
  });

  it("deleting a list drops its tags; the words stay in ALL", () => {
    load();
    vocab.listDeleted("L");
    expect(vocab.cachedLists(U)).toEqual([]);
    expect(vocab.wordsFor(U, "L")).toEqual([]);
    expect(vocab.wordsFor(U, null)).toHaveLength(2);
  });

  it("tags made before the membership arrives are replayed onto it", () => {
    vocab.vocabularyStore(U);
    vocab.appendPage(U, [makeUserWord({ userWordId: "a" })]);
    vocab.retagInCache("tag", "L", ["a"]);
    vocab.markComplete(U);
    vocab.setMembership(U, []); // the snapshot predates the tag
    expect(vocab.wordsFor(U, "L").map((w) => w.userWordId)).toEqual(["a"]);
  });

  it("a background re-check swaps in — unless a write landed while it ran", () => {
    load();
    const w0 = vocab.writesSoFar(U);
    const snapshot = { words: [makeUserWord({ userWordId: "z" })], membership: [], lists: [] };
    expect(vocab.replaceIfUnchanged(U, w0, snapshot)).toBe(true);
    expect(vocab.wordsFor(U, null).map((w) => w.userWordId)).toEqual(["z"]);

    const w1 = vocab.writesSoFar(U);
    vocab.removeWord("z"); // a local write during the next re-check
    expect(vocab.replaceIfUnchanged(U, w1, { words: [makeUserWord({ userWordId: "z" })], membership: [], lists: [] })).toBe(false);
    expect(vocab.wordsFor(U, null)).toEqual([]);
  });

  it("the overview memo lasts until the next write", () => {
    load();
    vocab.rememberOverview([]);
    expect(vocab.cachedOverview()).toEqual([]);
    vocab.retagInCache("untag", "L", ["a"]);
    expect(vocab.cachedOverview()).toBeNull();
  });

  it("an unchanged word keeps its object identity across reads; only a patched one is new", () => {
    const at = new Date().toISOString();
    const inputs = { stability: 10, lastReviewedDate: at, originallyTranslatedDate: at,
      shortStability: null, shortStabilityAt: null, peakConfidence: 0 };
    load([makeUserWord({ userWordId: "a", confidenceInputs: inputs }), makeUserWord({ userWordId: "b", confidenceInputs: inputs })]);
    const [a1, b1] = vocab.wordsFor(U, null);
    vocab.writeWordById("b", { stability: 20 });
    const [a2, b2] = vocab.wordsFor(U, null);
    expect(a2).toBe(a1);
    expect(b2).not.toBe(b1);
  });

  it("is one user at a time — another user's reads come back empty", () => {
    load();
    expect(vocab.wordsFor("someone-else", null)).toEqual([]);
    expect(vocab.isFresh("someone-else")).toBe(false);
  });
});
