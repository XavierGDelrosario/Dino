// Assembling dictated utterances into the input box.
//
// The point of these is the SEPARATOR CONTRACT, so most of them assert against
// `splitSentences` — the real consumer — rather than against the string. A test
// that only checked for "\n" would keep passing if someone swapped the separator
// for a space, which is exactly the change that silently collapses an hour of
// speech back into one sentence and stops any translation ever appearing.
import { describe, it, expect } from "vitest";
import { commitUtterance, withPartial } from "@/services/speech/dictation";
import { splitSentences } from "@/services/language/sentences";

describe("commitUtterance", () => {
  it("makes each utterance its OWN sentence, without inventing punctuation", () => {
    let box = "";
    box = commitUtterance(box, "今日は暑いですね");
    box = commitUtterance(box, "そうですね");

    // The speaker's pause is the boundary — note neither line has a 。
    expect(splitSentences(box).map((s) => s.text)).toEqual(["今日は暑いですね", "そうですね"]);
  });

  it("does not put a 。 (or any mark) into the text", () => {
    // A pause is evidence of a boundary, not of WHICH mark belongs there — and a
    // wrong one gets baked into text the user goes on to save.
    expect(commitUtterance("", "行きました")).not.toMatch(/[。．.！!？?]/);
  });

  it("continues from text that was already in the box", () => {
    // Typed first, then dictated: the typed line must not merge into the utterance.
    const box = commitUtterance("先に書いた文", "話した文");
    expect(splitSentences(box).map((s) => s.text)).toEqual(["先に書いた文", "話した文"]);
  });

  it("drops an empty utterance instead of opening a blank line", () => {
    // Recognizers emit one when a pause brought no speech.
    const box = commitUtterance("猫が好き", "");
    expect(commitUtterance(box, "   ")).toBe(box);
    expect(splitSentences(box)).toHaveLength(1);
  });

  it("keeps real punctuation when the speaker's recognizer supplies it", () => {
    const box = commitUtterance("", "本当ですか？");
    expect(splitSentences(box).map((s) => s.text)).toEqual(["本当ですか？"]);
  });
});

describe("withPartial", () => {
  it("shows the forming utterance after everything committed", () => {
    const box = commitUtterance("", "こんにちは");
    expect(withPartial(box, "げん")).toBe("こんにちは\nげん");
  });

  it("REPLACES the previous partial rather than appending to it", () => {
    // The recognizer re-sends the whole utterance as it grows; appending would
    // produce げんげんきげんきです.
    const box = commitUtterance("", "こんにちは");
    const a = withPartial(box, "げん");
    const b = withPartial(box, "げんき");
    expect(b).toBe("こんにちは\nげんき");
    expect(b.startsWith(a)).toBe(true); // grew, not concatenated twice
  });

  it("is not itself committed — it carries no trailing boundary", () => {
    // Only commitUtterance ends a sentence; a half-said line is not finished.
    expect(withPartial("", "まだ途中")).toBe("まだ途中");
  });

  it("leaves the box alone when the partial is empty", () => {
    const box = commitUtterance("", "猫");
    expect(withPartial(box, "")).toBe(box);
  });
});
