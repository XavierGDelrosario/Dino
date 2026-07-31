// Merging append-only utterance analyses into the one document the reader renders.
// The reader slices its `text` by token offsets to print what sits BETWEEN tokens,
// so an un-rebased offset doesn't just misplace a colour — it prints the wrong
// characters. That is what these pin.
import { describe, it, expect } from "vitest";
import { mergeTranscript, type TranscriptBlock } from "@/services/analyze/transcript";
import { makeWord } from "@test/fixtures";
import type { AnalyzedToken } from "@/services/language";

const tok = (text: string, start: number): AnalyzedToken => ({
  text,
  start,
  end: start + text.length,
  reading: null,
  lemma: null,
  pos: "名詞",
});

const block = (text: string, tokens: AnalyzedToken[], meanings: [string, ReturnType<typeof makeWord>[]][] = []): TranscriptBlock => ({
  text,
  tokens,
  meanings: new Map(meanings),
});

describe("mergeTranscript", () => {
  it("is empty for no utterances", () => {
    const merged = mergeTranscript([]);
    expect(merged.text).toBe("");
    expect(merged.tokens).toEqual([]);
    expect(merged.meanings.size).toBe(0);
  });

  it("joins utterances one per line", () => {
    const merged = mergeTranscript([block("猫が好き", []), block("犬も好き", [])]);
    expect(merged.text).toBe("猫が好き\n犬も好き");
  });

  it("REBASES offsets so every token still points at its own word", () => {
    const merged = mergeTranscript([
      block("猫が好き", [tok("猫", 0)]),
      block("犬も好き", [tok("犬", 0)]),
    ]);
    // The second block's 犬 was at 0 in its own utterance; after the join it must
    // land past "猫が好き" + the newline.
    const [neko, inu] = merged.tokens;
    expect(merged.text.slice(neko.start, neko.end)).toBe("猫");
    expect(merged.text.slice(inu.start, inu.end)).toBe("犬");
    expect(inu.start).toBe("猫が好き\n".length);
  });

  it("does not mutate the blocks it was given", () => {
    const second = block("犬", [tok("犬", 0)]);
    mergeTranscript([block("猫", [tok("猫", 0)]), second]);
    expect(second.tokens[0].start).toBe(0); // still relative to its own utterance
  });

  it("unions the meaning maps", () => {
    const merged = mergeTranscript([
      block("猫", [], [["猫", [makeWord({ input: "猫", translation: "cat" })]]]),
      block("犬", [], [["犬", [makeWord({ input: "犬", translation: "dog" })]]]),
    ]);
    expect(merged.meanings.get("猫")?.[0].translation).toBe("cat");
    expect(merged.meanings.get("犬")?.[0].translation).toBe("dog");
  });

  it("keeps the FIRST senses for a word said twice — the map stays stable as it grows", () => {
    const first = makeWord({ wordId: "w-1", input: "猫", translation: "cat" });
    const later = makeWord({ wordId: "w-2", input: "猫", translation: "cat (again)" });
    const merged = mergeTranscript([block("猫", [], [["猫", [first]]]), block("猫", [], [["猫", [later]]])]);
    expect(merged.meanings.get("猫")?.[0].wordId).toBe("w-1");
  });

  it("carries an un-analyzed line — a slow lookup must not drop it from the text", () => {
    const merged = mergeTranscript([
      block("聞き取り中", []), // placed before its analysis landed
      block("猫", [tok("猫", 0)]),
    ]);
    expect(merged.text).toBe("聞き取り中\n猫");
    expect(merged.tokens).toHaveLength(1);
    expect(merged.text.slice(merged.tokens[0].start, merged.tokens[0].end)).toBe("猫");
  });
});
