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

describe("recognizer punctuation (iOS addsPunctuation)", () => {
  // iOS often adds the mark that closes a line only once the NEXT words arrive, so it
  // lands at the head of the next utterance. It belongs to the line it closes.
  it("moves a leading 。 back onto the end of the previous line", () => {
    let box = commitUtterance("", "今日は雨です");
    box = commitUtterance(box, "。明日は晴れます。");
    expect(box).toBe("今日は雨です。\n明日は晴れます。\n");
    expect(splitSentences(box).map((s) => s.text)).toEqual(["今日は雨です。", "明日は晴れます。"]);
  });

  it("does the same while the next line is still forming", () => {
    const box = commitUtterance("", "本当");
    expect(withPartial(box, "？そうか")).toBe("本当？\nそうか");
  });

  it("an utterance that is ONLY the late mark closes the line and adds nothing", () => {
    const box = commitUtterance("", "行きました");
    expect(commitUtterance(box, "。")).toBe("行きました。\n");
  });

  it("does not double a mark the line already has", () => {
    const box = commitUtterance("", "行きました。");
    expect(commitUtterance(box, "。次")).toBe("行きました。\n次\n");
  });

  it("drops a leading mark when there is no line for it to close", () => {
    expect(commitUtterance("", "。こんにちは")).toBe("こんにちは\n");
  });

  it("leaves an OPENING bracket at the start of its own line", () => {
    const box = commitUtterance("", "彼は言った");
    expect(commitUtterance(box, "「行こう」")).toBe("彼は言った\n「行こう」\n");
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
