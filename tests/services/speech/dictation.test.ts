// Assembling dictated utterances into the input box.
//
// The point of these is the SEPARATOR CONTRACT, so most of them assert against
// `splitSentences` — the real consumer — rather than against the string. A test
// that only checked for "\n" would keep passing if someone swapped the separator
// for a space, which is exactly the change that silently collapses an hour of
// speech back into one sentence and stops any translation ever appearing.
import { describe, it, expect } from "vitest";
import { commitUtterance, lastSentenceEnd, withPartial } from "@/services/speech/dictation";
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

describe("punctuated utterances flow on as prose", () => {
  // A line break after a sentence that already has its 。 says nothing — it only
  // chops the box into one line per breath.
  it("puts no line break after an utterance that ends on its own mark", () => {
    let box = commitUtterance("", "今日は雨です。");
    box = commitUtterance(box, "明日は晴れます。");
    expect(box).toBe("今日は雨です。明日は晴れます。");
    expect(splitSentences(box).map((s) => s.text)).toEqual(["今日は雨です。", "明日は晴れます。"]);
  });

  it("separates Latin-script sentences with a space", () => {
    const box = commitUtterance("", "It rained.");
    expect(commitUtterance(box, "Then it stopped.")).toBe("It rained. Then it stopped.");
  });

  it("keeps the line break only where the utterance brought no mark", () => {
    let box = commitUtterance("", "今日は雨です。");
    box = commitUtterance(box, "そうですね");
    expect(box).toBe("今日は雨です。そうですね\n");
  });

  it("continues a line that paused on a comma", () => {
    expect(withPartial("明日は、", "晴れ")).toBe("明日は、晴れ");
  });
});

describe("recognizer punctuation (iOS addsPunctuation)", () => {
  // iOS often adds the mark that closes a line only once the NEXT words arrive, so it
  // lands at the head of the next utterance. It belongs to the line it closes.
  it("moves a leading 。 back onto the end of the previous line, replacing its line break", () => {
    let box = commitUtterance("", "今日は雨です");
    box = commitUtterance(box, "。明日は晴れます。");
    expect(box).toBe("今日は雨です。明日は晴れます。");
    expect(splitSentences(box).map((s) => s.text)).toEqual(["今日は雨です。", "明日は晴れます。"]);
  });

  it("does the same while the next line is still forming", () => {
    const box = commitUtterance("", "本当");
    expect(withPartial(box, "？そうか")).toBe("本当？そうか");
  });

  it("an utterance that is ONLY the late mark closes the line and adds nothing", () => {
    const box = commitUtterance("", "行きました");
    expect(commitUtterance(box, "。")).toBe("行きました。");
  });

  it("does not double a mark the line already has", () => {
    const box = commitUtterance("", "行きました。");
    expect(commitUtterance(box, "。次")).toBe("行きました。次\n");
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

// Where a pause may cut a punctuated utterance into a line: from the previous sentence
// end to the LAST one. Commas pause a sentence; they never end it.
describe("lastSentenceEnd", () => {
  it("cuts after the last terminator, leaving the sentence still being said", () => {
    const t = "今日は雨です。明日は";
    expect(t.slice(0, lastSentenceEnd(t))).toBe("今日は雨です。");
  });

  it("takes every finished sentence, not just the first", () => {
    const t = "雨です。寒いですか？明日は";
    expect(t.slice(0, lastSentenceEnd(t))).toBe("雨です。寒いですか？");
  });

  it("never cuts at a comma", () => {
    expect(lastSentenceEnd("明日は、")).toBe(0);
    expect(lastSentenceEnd("雨です。明日は、晴れ、")).toBe("雨です。".length);
    expect(lastSentenceEnd("Well, I think, maybe")).toBe(0);
  });

  it("keeps a closing bracket with its sentence and ignores a 。 inside a quote", () => {
    const t = "彼は「行くよ。」と言った。それで";
    expect(t.slice(0, lastSentenceEnd(t))).toBe("彼は「行くよ。」と言った。");
  });

  it("ignores the previous line's late 。 at the head of the utterance", () => {
    expect(lastSentenceEnd("。明日は晴れ")).toBe(0);
    expect(lastSentenceEnd("。明日は晴れ。")).toBe("。明日は晴れ。".length);
  });

  it("does not treat a decimal point as a sentence end", () => {
    expect(lastSentenceEnd("It costs 3.5 dollars")).toBe(0);
  });
});
