import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeWord, FIXTURE_WORDS } from "@test/fixtures";
import { createMockSenseProvider, createMockTranslate } from "@test/mockProviders";

// lookup.ts is READ-only: it surfaces meanings and a display translation but
// never writes to a user's lists. Mock the data + provider boundaries.
vi.mock("@/services/words/repository", () => ({
  findWordTranslations: vi.fn(),
  findWordTranslationsBatch: vi.fn(),
}));
vi.mock("@/services/translation", () => ({
  translate: vi.fn(),
  translateBatch: vi.fn(),
  // The paragraph gloss goes through the CACHE (glossSentences), not the raw
  // client — so a sentence bought by a reader tap isn't paid for twice.
  glossSentences: vi.fn(),
}));
vi.mock("@/services/senses", () => ({ resolveSenseProvider: vi.fn() }));
// Partial-mock language: keep the real resolveSourceLanguage / AUTO_DETECT, but
// stub the kuromoji-backed analyze() so these stay fast unit tests (no ~12MB
// dictionary load). The real engine is covered in language/analyze.test.ts.
vi.mock("@/services/language", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/language")>()),
  analyze: vi.fn(),
}));

import { findWordTranslations, findWordTranslationsBatch } from "@/services/words/repository";
import { translate, translateBatch, glossSentences } from "@/services/translation";
import { resolveSenseProvider } from "@/services/senses";
import { analyze } from "@/services/language";
import { lookupWord, lookupWordsBatch, translateParagraph , wordKey} from "@/services/lookup";
import { __clearWordsCache } from "@/services/words/cache";
import type { Word } from "@/services/words/repository";

const mockFind = vi.mocked(findWordTranslations);
const mockFindBatch = vi.mocked(findWordTranslationsBatch);
const mockTranslate = vi.mocked(translate);
const mockTranslateBatch = vi.mocked(translateBatch);
const mockTranslateSegments = vi.mocked(glossSentences);
const mockResolveProvider = vi.mocked(resolveSenseProvider);
const mockAnalyze = vi.mocked(analyze);

beforeEach(() => {
  vi.clearAllMocks();
  // Default: the batched edge call (used by translateParagraph for uncached
  // words) returns nothing; tests that seed a missing word override this.
  mockTranslateBatch.mockResolvedValue(new Map<string, Word[]>());
  // Default: the display gloss echoes one translation per SENTENCE (that 1:1
  // shape is the contract the reader's inline gloss depends on). Tests that
  // care about the text override this.
  mockTranslateSegments.mockImplementation(async (p) => p.segments.map((s) => `[EN] ${s}`));
});

describe("lookupWord", () => {
  it("returns ALL cached meanings without invoking a sense provider", async () => {
    const meanings = [
      makeWord({ wordId: "ja-takai-1", input: "高い", translation: "high" }),
      makeWord({ wordId: "ja-takai-2", input: "高い", translation: "expensive" }),
    ];
    mockFind.mockResolvedValue(meanings);

    const res = await lookupWord({ input: "高い", targetLang: "EN" });

    expect(res.sourceLang).toBe("JA");
    expect(res.meanings.map((m) => m.translation)).toEqual(["high", "expensive"]);
    expect(mockResolveProvider).not.toHaveBeenCalled();
  });

  it("no-context lookup: each homograph sense carries its OWN reading from words (never swapped)", async () => {
    // 辛い is two JMdict entries → two words rows, each with its own reading.
    // Single-word lookup has no sentence context, so the `words` reading IS the
    // furigana — kuromoji is not consulted here. からい must stay on spicy.
    mockFind.mockResolvedValue([
      makeWord({ input: "辛い", translation: "spicy", inputReading: "からい" }),
      makeWord({ input: "辛い", translation: "painful", inputReading: "つらい" }),
    ]);

    const res = await lookupWord({ input: "辛い", targetLang: "EN" });

    const spicy = res.meanings.find((m) => m.translation === "spicy");
    const painful = res.meanings.find((m) => m.translation === "painful");
    expect(spicy?.inputReading).toBe("からい");
    expect(painful?.inputReading).toBe("つらい");
    expect(mockResolveProvider).not.toHaveBeenCalled(); // cache hit, no kuromoji/provider
  });

  it("seeds meanings from the sense provider on a cache miss (multi-sense)", async () => {
    mockFind.mockResolvedValue([]); // nothing cached yet
    // The mock dictionary returns BOTH senses of 高い — the multi-sense path the
    // real MT fallback can't produce.
    mockResolveProvider.mockReturnValue(createMockSenseProvider(FIXTURE_WORDS));

    const res = await lookupWord({ input: "高い", targetLang: "EN" });

    expect(mockResolveProvider).toHaveBeenCalledWith("JA", "EN");
    expect(res.meanings.map((m) => m.translation)).toEqual(["high", "expensive"]);
  });

  it("trims and NFC-normalizes the input", async () => {
    mockFind.mockResolvedValue([makeWord()]);
    const res = await lookupWord({ input: "  猫  ", targetLang: "EN" });
    expect(res.input).toBe("猫");
  });
});

// The single-word reading override (readingOverrides.ts) reprioritizes the PRIMARY
// sense for a handful of common standalone words whose everyday reading loses
// jmdict_lookup's frequency tiebreak. These lock the WIRING (that lookupWord
// applies it), complementing the pure-function tests in readingOverrides.test.ts.
describe("lookupWord — single-word reading override", () => {
  it("reprioritizes the verified reading (前 → まえ, not the jmdict さき tiebreak)", async () => {
    // jmdict can headline the さき entry first; the override must surface まえ.
    mockFind.mockResolvedValue([
      makeWord({ wordId: "saki", input: "前", translation: "previous", inputReading: "さき" }),
      makeWord({ wordId: "mae", input: "前", translation: "front; before", inputReading: "まえ" }),
    ]);

    const res = await lookupWord({ input: "前", targetLang: "EN" });

    expect(res.meanings[0].inputReading).toBe("まえ"); // primary is now まえ
    expect(res.meanings.map((m) => m.inputReading)).toEqual(["まえ", "さき"]);
  });

  it("applies the override on the cache-MISS (provider) path too", async () => {
    mockFind.mockResolvedValue([]); // miss → provider
    mockResolveProvider.mockReturnValue(
      createMockSenseProvider([
        makeWord({ wordId: "saki", input: "前", translation: "previous", inputReading: "さき" }),
        makeWord({ wordId: "mae", input: "前", translation: "front", inputReading: "まえ" }),
      ]),
    );

    const res = await lookupWord({ input: "前", targetLang: "EN" });

    expect(res.meanings[0].inputReading).toBe("まえ");
  });

  it("leaves a non-override word's sense order untouched (猫)", async () => {
    mockFind.mockResolvedValue([
      makeWord({ wordId: "a", input: "猫", translation: "cat", inputReading: "ねこ" }),
      makeWord({ wordId: "b", input: "猫", translation: "shamisen", inputReading: "ねこ" }),
    ]);

    const res = await lookupWord({ input: "猫", targetLang: "EN" });

    expect(res.meanings.map((m) => m.wordId)).toEqual(["a", "b"]);
  });

  it("is a no-op when the preferred reading isn't present (never invents まえ)", async () => {
    mockFind.mockResolvedValue([
      makeWord({ wordId: "zen", input: "前", translation: "before (pref.)", inputReading: "ぜん" }),
      makeWord({ wordId: "saki", input: "前", translation: "previous", inputReading: "さき" }),
    ]);

    const res = await lookupWord({ input: "前", targetLang: "EN" });

    expect(res.meanings.map((m) => m.wordId)).toEqual(["zen", "saki"]); // unchanged
  });
});

describe("translateParagraph", () => {
  it("glosses the paragraph SENTENCE BY SENTENCE and maps each word to its meanings", async () => {
    // The display gloss is a segments call (never persisted); per-word seeding
    // still uses the fixture-backed sense provider below.
    mockTranslate.mockImplementation(createMockTranslate(FIXTURE_WORDS));
    mockTranslateSegments.mockResolvedValue(["the cat and the dog"]);
    // 猫 already cached; 犬 missing → seeded via the batched edge call.
    mockFindBatch.mockResolvedValue(
      new Map([["猫", [makeWord({ wordId: "ja-neko", input: "猫", translation: "cat" })]]])
    );
    mockTranslateBatch.mockResolvedValue(
      new Map([["犬", [makeWord({ wordId: "ja-inu", input: "犬", translation: "dog" })]]])
    );
    // Analysis is mocked: two tokens, each carrying a (best-effort) reading.
    mockAnalyze.mockResolvedValue([
      { text: "猫", start: 0, end: 1, reading: "ねこ", lemma: "猫", pos: null },
      { text: "犬", start: 2, end: 3, reading: "いぬ", lemma: "犬", pos: null },
    ]);

    const res = await translateParagraph({ input: "猫 犬", targetLang: "EN" });

    // The gloss goes through the SEGMENTS path (display-only by construction —
    // it has no persist option and never touches the cache).
    expect(mockTranslateSegments).toHaveBeenCalledWith({
      segments: ["猫 犬"],
      sourceLang: "JA",
      targetLang: "EN",
    });
    expect(res.translated).toBe(true);
    expect(res.translation).toBe("the cat and the dog");
    expect(res.sourceLang).toBe("JA");
    expect(res.meanings.get("猫")?.[0].translation).toBe("cat");
    expect(res.meanings.get("犬")?.[0].translation).toBe("dog"); // seeded
    expect(res.tokens.length).toBeGreaterThanOrEqual(2);
    // Per-token readings propagate from analysis to the tokens.
    expect(res.tokens.find((t) => t.text === "猫")?.reading).toBe("ねこ");
  });

  it("overrides kuromoji with the unambiguous reading already on the looked-up word", async () => {
    mockTranslate.mockResolvedValue({ translated: true, translation: "now", word: null });
    // The dictionary sense (looked up for its meaning) already carries the
    // authoritative reading — one distinct reading → unambiguous → override.
    mockFindBatch.mockResolvedValue(
      new Map([["今", [makeWord({ input: "今", translation: "now", inputReading: "いま" })]]])
    );
    // kuromoji misreads 今 in isolation as こん; lemma 今.
    mockAnalyze.mockResolvedValue([{ text: "今", start: 0, end: 1, reading: "こん", lemma: "今", pos: null }]);

    const res = await translateParagraph({ input: "今", targetLang: "EN" });
    expect(res.tokens.find((t) => t.text === "今")?.reading).toBe("いま"); // overridden
  });

  it("keeps kuromoji's reading when the dictionary lists SEVERAL readings (ambiguous → trust context)", async () => {
    mockTranslate.mockResolvedValue({ translated: true, translation: "spicy", word: null });
    // 辛い: からい (spicy) vs つらい (painful) — two distinct readings → ambiguous.
    mockFindBatch.mockResolvedValue(
      new Map([
        ["辛い", [
          makeWord({ input: "辛い", translation: "spicy", inputReading: "からい" }),
          makeWord({ input: "辛い", translation: "painful", inputReading: "つらい" }),
        ]],
      ])
    );
    mockAnalyze.mockResolvedValue([{ text: "辛い", start: 0, end: 2, reading: "からい", lemma: "辛い", pos: null }]);

    const res = await translateParagraph({ input: "辛い", targetLang: "EN" });
    expect(res.tokens.find((t) => t.text === "辛い")?.reading).toBe("からい"); // kuromoji's context guess kept
  });

  it("does NOT override a CONJUGATED surface — keeps kuromoji's reading (行った → いった, not lemma いく)", async () => {
    mockTranslate.mockResolvedValue({ translated: true, translation: "went", word: null });
    // Looked up by LEMMA 行く (stored reading いく), but the surface 行った reads いった.
    // The override applies only when the surface IS the dictionary form (text === lemma),
    // so the lemma's いく must NOT overwrite the conjugated surface's いった.
    mockFindBatch.mockResolvedValue(
      new Map([["行く", [makeWord({ input: "行く", translation: "to go", inputReading: "いく" })]]])
    );
    mockAnalyze.mockResolvedValue([{ text: "行った", start: 0, end: 3, reading: "いった", lemma: "行く", pos: null }]);

    const res = await translateParagraph({ input: "行った", targetLang: "EN" });
    expect(res.tokens.find((t) => t.text === "行った")?.reading).toBe("いった"); // surface reading kept
    expect(res.meanings.get("行く")?.[0].translation).toBe("to go"); // keyed by wordKey = the LEMMA (see lookup.wordKey)
  });

  it("keeps the kuromoji reading when the word has no dictionary entry", async () => {
    mockTranslate.mockResolvedValue({ translated: true, translation: "cat", word: null });
    mockFindBatch.mockResolvedValue(new Map()); // not in words
    mockAnalyze.mockResolvedValue([{ text: "猫", start: 0, end: 1, reading: "ねこ", lemma: "猫", pos: null }]);

    const res = await translateParagraph({ input: "猫", targetLang: "EN" });
    expect(res.tokens.find((t) => t.text === "猫")?.reading).toBe("ねこ");
  });

  it("conjugated form (行った): meaning resolves via the LEMMA, furigana keeps kuromoji's SURFACE reading (cache hit)", async () => {
    mockTranslate.mockResolvedValue({ translated: true, translation: "went", word: null });
    // 行く is cached (keyed by the lemma); 行った is the surface in the sentence.
    mockFindBatch.mockResolvedValue(
      new Map([["行く", [makeWord({ input: "行く", translation: "to go", inputReading: "いく" })]]])
    );
    // kuromoji: surface 行った, lemma 行く, surface reading いった.
    mockAnalyze.mockResolvedValue([{ text: "行った", start: 0, end: 3, reading: "いった", lemma: "行く", pos: null }]);

    const res = await translateParagraph({ input: "行った", targetLang: "EN" });

    // Meaning found via the LEMMA, then re-keyed under the surface text.
    expect(res.meanings.get("行く")?.[0].translation).toBe("to go");
    // Reading is the SURFACE reading from kuromoji — NOT the lemma reading いく.
    expect(res.tokens.find((t) => t.text === "行った")?.reading).toBe("いった");
  });

  it("conjugated form (行った): same result on a cache MISS (lemma seeded via the batched edge call)", async () => {
    mockTranslate.mockResolvedValue({ translated: true, translation: "went", word: null });
    mockFindBatch.mockResolvedValue(new Map()); // 行く not cached
    mockTranslateBatch.mockResolvedValue(
      new Map([["行く", [makeWord({ input: "行く", translation: "to go", inputReading: "いく" })]]])
    );
    mockAnalyze.mockResolvedValue([{ text: "行った", start: 0, end: 3, reading: "いった", lemma: "行く", pos: null }]);

    const res = await translateParagraph({ input: "行った", targetLang: "EN" });

    expect(res.meanings.get("行く")?.[0].translation).toBe("to go"); // seeded via lemma
    expect(res.tokens.find((t) => t.text === "行った")?.reading).toBe("いった"); // surface reading kept
  });

  it("falls back to showing the input when the paragraph can't be translated", async () => {
    mockTranslateSegments.mockResolvedValue([null]); // MT off / provider empty
    mockFindBatch.mockResolvedValue(new Map());
    mockAnalyze.mockResolvedValue([{ text: "猫", start: 0, end: 1, reading: "ねこ", lemma: "猫", pos: null }]);

    const res = await translateParagraph({ input: "猫", targetLang: "EN" });
    expect(res.translated).toBe(false);
    expect(res.translation).toBe("猫");
    expect(res.sentences).toEqual([{ text: "猫", start: 0, end: 1, gloss: null }]);
  });

  // The inline reader gloss depends on this shape: one entry per sentence, each
  // carrying the offsets that let the reader group its already-analyzed tokens.
  it("returns one gloss per sentence, with offsets into the paragraph", async () => {
    mockTranslateSegments.mockResolvedValue(["The cat ran.", "The dog slept."]);
    mockFindBatch.mockResolvedValue(new Map());
    mockAnalyze.mockResolvedValue([]);

    const res = await translateParagraph({ input: "猫が走った。犬が寝た。", targetLang: "EN" });

    expect(mockTranslateSegments).toHaveBeenCalledWith(
      expect.objectContaining({ segments: ["猫が走った。", "犬が寝た。"] }),
    );
    expect(res.sentences).toEqual([
      { text: "猫が走った。", start: 0, end: 6, gloss: "The cat ran." },
      { text: "犬が寝た。", start: 6, end: 11, gloss: "The dog slept." },
    ]);
    // The output box still gets one paragraph string, stitched from the parts.
    expect(res.translation).toBe("The cat ran. The dog slept.");
  });

  it("keeps a partially-failed gloss aligned — the failed sentence shows its source", async () => {
    mockTranslateSegments.mockResolvedValue(["The cat ran.", null]);
    mockFindBatch.mockResolvedValue(new Map());
    mockAnalyze.mockResolvedValue([]);

    const res = await translateParagraph({ input: "猫が走った。犬が寝た。", targetLang: "EN" });
    expect(res.sentences.map((s) => s.gloss)).toEqual(["The cat ran.", null]);
    expect(res.translated).toBe(true); // something landed
    expect(res.translation).toBe("The cat ran. 犬が寝た。");
  });

  it("makes NO gloss call when skipGloss is set (the media summary path spends nothing)", async () => {
    mockFindBatch.mockResolvedValue(new Map());
    mockAnalyze.mockResolvedValue([]);

    const res = await translateParagraph({ input: "猫が走った。", targetLang: "EN", skipGloss: true });
    expect(mockTranslateSegments).not.toHaveBeenCalled();
    expect(res.translated).toBe(false);
    // …but the SPANS still come back. Splitting is free string work, and the
    // reader draws its per-sentence affordance from these: returning [] here left
    // the live reader and the article page with nothing to click until a
    // whole-text gloss had been bought, which re-split the text as a side effect.
    expect(res.sentences).toEqual([
      { text: "猫が走った。", start: 0, end: 6, gloss: null },
    ]);
  });

  it("skipGloss returns a span per sentence, all unglossed", async () => {
    mockFindBatch.mockResolvedValue(new Map());
    mockAnalyze.mockResolvedValue([]);

    const res = await translateParagraph({
      input: "猫が走った。犬も走った。",
      targetLang: "EN",
      skipGloss: true,
    });
    expect(res.sentences.map((s) => s.text)).toEqual(["猫が走った。", "犬も走った。"]);
    expect(res.sentences.every((s) => s.gloss === null)).toBe(true);
    expect(mockTranslateSegments).not.toHaveBeenCalled();
  });

  it("survives a gloss failure — the reader still renders", async () => {
    mockTranslateSegments.mockRejectedValue(new Error("edge down"));
    mockFindBatch.mockResolvedValue(
      new Map([["猫", [makeWord({ input: "猫", translation: "cat" })]]]),
    );
    mockAnalyze.mockResolvedValue([{ text: "猫", start: 0, end: 1, reading: "ねこ", lemma: "猫", pos: null }]);

    const res = await translateParagraph({ input: "猫", targetLang: "EN" });
    expect(res.translated).toBe(false);
    expect(res.meanings.get("猫")?.[0].translation).toBe("cat"); // reader intact
  });
});

describe("lookupWordsBatch (EN→JA fan-out stage 2)", () => {
  it("merges cached words with edge-seeded misses in ONE batch each", async () => {
    // バット cached; 蝙蝠 missing → seeded via the batched edge call.
    mockFindBatch.mockResolvedValue(
      new Map([["バット", [makeWord({ wordId: "bat-1", input: "バット", translation: "bat (baseball)" })]]])
    );
    mockTranslateBatch.mockResolvedValue(
      new Map([["蝙蝠", [makeWord({ wordId: "bat-2", input: "蝙蝠", translation: "bat (animal)" })]]])
    );

    const map = await lookupWordsBatch({ inputs: ["バット", "蝙蝠"], sourceLang: "JA", targetLang: "EN" });

    // Only the MISS goes to the edge, deduped/normalized.
    expect(mockTranslateBatch).toHaveBeenCalledWith({ inputs: ["蝙蝠"], sourceLang: "JA", targetLang: "EN" });
    expect(map.get("バット")?.[0].translation).toBe("bat (baseball)");
    expect(map.get("蝙蝠")?.[0].translation).toBe("bat (animal)");
  });

  it("de-dupes + NFC-normalizes inputs before the DB read", async () => {
    mockFindBatch.mockResolvedValue(new Map());
    await lookupWordsBatch({ inputs: ["猫", "猫", "  犬  "], sourceLang: "JA", targetLang: "EN" });
    expect(mockFindBatch).toHaveBeenCalledWith({ inputs: ["猫", "犬"], sourceLang: "JA", targetLang: "EN" });
  });

  it("survives an edge failure — cached candidates still resolve", async () => {
    mockFindBatch.mockResolvedValue(
      new Map([["バット", [makeWord({ wordId: "bat-1", input: "バット", translation: "bat" })]]])
    );
    mockTranslateBatch.mockRejectedValue(new Error("edge down"));

    const map = await lookupWordsBatch({ inputs: ["バット", "蝙蝠"], sourceLang: "JA", targetLang: "EN" });
    expect(map.get("バット")?.[0].translation).toBe("bat"); // cached survives
    expect(map.has("蝙蝠")).toBe(false); // the miss is just absent
  });

  it("does nothing (no calls) for an empty input list", async () => {
    const map = await lookupWordsBatch({ inputs: [], sourceLang: "JA", targetLang: "EN" });
    expect(map.size).toBe(0);
    expect(mockFindBatch).not.toHaveBeenCalled();
    expect(mockTranslateBatch).not.toHaveBeenCalled();
  });
});

describe("translateParagraph — dictionary-validated compound merge", () => {
  const FRAGMENTS = [
    { text: "柔軟", start: 0, end: 2, reading: "じゅうなん", lemma: "柔軟", pos: "名詞" },
    { text: "剤", start: 2, end: 3, reading: "ざい", lemma: "剤", pos: "名詞" },
  ];
  const paragraph = () =>
    translateParagraph({ input: "柔軟剤", sourceLang: "JA", targetLang: "EN" });

  beforeEach(() => {
    __clearWordsCache(); // the memo is module-global; misses would leak between tests
    mockAnalyze.mockResolvedValue(structuredClone(FRAGMENTS));
    mockFindBatch.mockResolvedValue(new Map<string, Word[]>());
    mockTranslate.mockResolvedValue({
      translated: true,
      translation: "fabric softener",
      word: null,
    });
  });

  const probeCalls = () =>
    mockTranslateBatch.mock.calls.filter((c) => c[0].dictionaryOnly === true);

  it("asks the dictionary about the noun run — and asks DICTIONARY-ONLY, never paid MT", async () => {
    await paragraph();
    expect(probeCalls()).toHaveLength(1);
    expect(probeCalls()[0][0].inputs).toContain("柔軟剤");
  });

  it("merges the compound when the dictionary confirms it", async () => {
    const softener = makeWord({ input: "柔軟剤", translation: "fabric softener" });
    mockTranslateBatch.mockImplementation(async (p) =>
      p.dictionaryOnly ? new Map([["柔軟剤", [softener]]]) : new Map<string, Word[]>(),
    );
    const res = await paragraph();
    expect(res.tokens.map((t) => t.text)).toEqual(["柔軟剤"]);
  });

  it("leaves the fragments split when the dictionary has no such word", async () => {
    const res = await paragraph();
    expect(res.tokens.map((t) => t.text)).toEqual(["柔軟", "剤"]);
  });

  it("does not re-probe a term the dictionary already rejected this session", async () => {
    await paragraph();
    await paragraph(); // same text again — the miss is already known
    expect(probeCalls()).toHaveLength(1);
  });

  it("still renders the paragraph when the probe call fails", async () => {
    mockTranslateBatch.mockRejectedValue(new Error("edge down"));
    const res = await paragraph();
    expect(res.tokens.map((t) => t.text)).toEqual(["柔軟", "剤"]);
  });
});

describe("translateParagraph — katakana the dictionary doesn't have", () => {
  // ゼレンスキー (a name, MT-only) next to リーグ (a real JMdict loanword).
  const TOKENS = [
    { text: "ゼレンスキー", start: 0, end: 6, reading: null, lemma: null, pos: "名詞" },
    { text: "リーグ", start: 6, end: 9, reading: null, lemma: null, pos: "名詞" },
  ];
  // No POS ⇒ the row came from the MT fallback, not the dictionary projection.
  const mtOnly = makeWord({ input: "ゼレンスキー", translation: "Zelensky", partOfSpeech: null });
  const fromDictionary = makeWord({
    input: "リーグ",
    translation: "league",
    partOfSpeech: ["n"],
    frequency: 450,
  });

  beforeEach(() => {
    __clearWordsCache();
    mockAnalyze.mockResolvedValue(structuredClone(TOKENS));
    mockTranslate.mockResolvedValue({ translated: true, translation: "", word: null });
    mockTranslateBatch.mockResolvedValue(new Map<string, Word[]>());
  });

  const paragraph = () =>
    translateParagraph({ input: "ゼレンスキーリーグ", sourceLang: "JA", targetLang: "EN" });

  it("hides an MT-only katakana word, and keeps the one the dictionary has", async () => {
    mockFindBatch.mockResolvedValue(
      new Map([
        ["ゼレンスキー", [mtOnly]],
        ["リーグ", [fromDictionary]],
      ]),
    );
    const res = await paragraph();
    // The name is still a TOKEN (the reader shows the text) but has no meanings,
    // so it renders grey: not addable, not in the word list, not in Add all.
    expect(res.tokens.map((t) => t.text)).toContain("ゼレンスキー");
    expect(res.meanings.get("ゼレンスキー")).toEqual([]);
    expect(res.meanings.get("リーグ")?.[0].translation).toBe("league");
  });

  it("a dictionary-backed katakana word with NO frequency survives (ゼロ, not junk)", async () => {
    // The signal is POS, never frequency: real JMdict entries can be unranked.
    mockAnalyze.mockResolvedValue([
      { text: "ゼロ", start: 0, end: 2, reading: null, lemma: null, pos: "名詞" },
    ]);
    mockFindBatch.mockResolvedValue(
      new Map([
        ["ゼロ", [makeWord({ input: "ゼロ", translation: "zero", partOfSpeech: ["n"], frequency: null })]],
      ]),
    );
    const res = await translateParagraph({ input: "ゼロ", sourceLang: "JA", targetLang: "EN" });
    expect(res.meanings.get("ゼロ")?.[0].translation).toBe("zero");
  });

  it("an MT-only KANJI word is untouched — the rule is katakana-scoped", async () => {
    // On the -common- JMdict subset, real words like 唐揚げ are MT-covered.
    mockAnalyze.mockResolvedValue([
      { text: "唐揚げ", start: 0, end: 3, reading: null, lemma: null, pos: "名詞" },
    ]);
    mockFindBatch.mockResolvedValue(
      new Map([["唐揚げ", [makeWord({ input: "唐揚げ", translation: "karaage", partOfSpeech: null })]]]),
    );
    const res = await translateParagraph({ input: "唐揚げ", sourceLang: "JA", targetLang: "EN" });
    expect(res.meanings.get("唐揚げ")?.[0].translation).toBe("karaage");
  });

  it("uncached katakana is resolved DICTIONARY-ONLY; the rest still gets paid MT", async () => {
    mockFindBatch.mockResolvedValue(new Map<string, Word[]>()); // nothing cached
    await paragraph();
    const calls = mockTranslateBatch.mock.calls.map((c) => c[0]);
    const kana = calls.find((c) => c.inputs.includes("ゼレンスキー"));
    expect(kana?.dictionaryOnly).toBe(true);
    expect(kana?.inputs).toEqual(["ゼレンスキー", "リーグ"]); // both katakana
  });

  it("sends non-katakana misses to the normal (MT-eligible) batch", async () => {
    mockAnalyze.mockResolvedValue([
      { text: "ゼレンスキー", start: 0, end: 6, reading: null, lemma: null, pos: "名詞" },
      { text: "猫", start: 6, end: 7, reading: null, lemma: null, pos: "名詞" },
    ]);
    mockFindBatch.mockResolvedValue(new Map<string, Word[]>());
    await translateParagraph({ input: "ゼレンスキー猫", sourceLang: "JA", targetLang: "EN" });
    const calls = mockTranslateBatch.mock.calls.map((c) => c[0]);
    expect(calls.find((c) => c.inputs.includes("猫"))?.dictionaryOnly).toBeUndefined();
    expect(calls.find((c) => c.inputs.includes("ゼレンスキー"))?.dictionaryOnly).toBe(true);
  });
});

// The English POS tagger's ONE cost consumer. Same shape as the katakana rule above and
// for the same reason: a miss that was never going to be a word must not be BILLED as
// one. Measured on en.wikinews, 23.5% of English lookup keys miss the dictionary
// against 5.5% for Japanese, the misses overwhelmingly names.
describe("translateParagraph — proper nouns never reach paid MT", () => {
  const propnTokens = [
    { text: "Abidal", start: 0, end: 6, reading: null, lemma: null, pos: "PROPN" },
    { text: "scored", start: 7, end: 13, reading: null, lemma: null, pos: "VERB" },
  ];

  it("routes a PROPN miss to a DICTIONARY-ONLY batch and the content word to the MT one", async () => {
    mockAnalyze.mockResolvedValue(propnTokens);
    mockFindBatch.mockResolvedValue(new Map<string, Word[]>()); // nothing cached
    await translateParagraph({ input: "Abidal scored", sourceLang: "EN", targetLang: "JA" });

    const calls = mockTranslateBatch.mock.calls.map((c) => c[0]);
    expect(calls.find((c) => c.inputs.includes("Abidal"))?.dictionaryOnly).toBe(true);
    // `scored` is an ordinary verb — it keeps its MT fallback, so the saving is
    // targeted rather than a blanket "stop paying for English".
    expect(calls.find((c) => c.inputs.includes("scored"))?.dictionaryOnly).toBeUndefined();
  });

  it("a proper noun the DICTIONARY knows still resolves, and stays vocabulary", async () => {
    // The reason PROPN is a content POS rather than a demotion. Measured on the UD test
    // split, a blanket demote-on-PROPN removed 2.93% of genuine content words, and they
    // were capitalised common nouns the dictionary has entries for. Letting the
    // dictionary arbitrate costs nothing and keeps those words addable.
    mockAnalyze.mockResolvedValue([
      { text: "Japan", start: 0, end: 5, reading: null, lemma: null, pos: "PROPN" },
    ]);
    const japan = makeWord({ input: "Japan", translation: "日本", partOfSpeech: null });
    mockFindBatch.mockResolvedValue(new Map([["Japan", [japan]]]));

    const res = await translateParagraph({ input: "Japan", sourceLang: "EN", targetLang: "JA" });
    // `meanings` is keyed by wordKey, which LOWERCASES (that is the case-folding fix
    // documented below); the lookup keys that reach the edge keep their case, which is
    // why the batch above matches on "Abidal" and this matches on "japan".
    expect(res.meanings.get("japan")?.[0].translation).toBe("日本");
    // Cached, so it never needed the edge at all.
    expect(mockTranslateBatch).not.toHaveBeenCalled();
  });
});

// One word, one entry. The surface used to be the key, so it forked on CASE
// ("Cats" at the start of a sentence vs "cats" mid-sentence) and on INFLECTION
// (cat vs cats) — one word became two hover cards, two quiz cards and two rows in the
// word list, with identical meanings, which reads as a bug rather than a distinction.
describe("wordKey — one word, one entry", () => {
  it("collapses case", () => {
    expect(wordKey({ text: "Cats" })).toBe(wordKey({ text: "cats" }));
  });

  it("collapses an inflection via the lemma", () => {
    expect(wordKey({ text: "cats", lemma: "cat" })).toBe(wordKey({ text: "cat" }));
  });

  it("collapses BOTH at once — sentence-initial and plural", () => {
    expect(wordKey({ text: "Cats", lemma: "cat" })).toBe(wordKey({ text: "cat" }));
  });

  it("keeps genuinely different words apart", () => {
    expect(wordKey({ text: "cat" })).not.toBe(wordKey({ text: "dog" }));
  });

  // Safe for Japanese: kuromoji supplies the lemma, and lowercasing is a no-op on
  // kana and kanji.
  it("is a no-op on Japanese beyond the lemma it already uses", () => {
    expect(wordKey({ text: "行った", lemma: "行く" })).toBe("行く");
    expect(wordKey({ text: "猫" })).toBe("猫");
  });
});
