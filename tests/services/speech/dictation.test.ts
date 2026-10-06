// Assembling dictated utterances into the input box.
//
// The contract: dictation writes PROSE. Utterances are appended on the same line and
// dictation never inserts a line break or invents punctuation; sentence boundaries
// come only from marks the recognizer supplies.
import { describe, it, expect } from "vitest";
import { commitUtterance, lastSentenceEnd, withPartial } from "@/services/speech/dictation";
import { splitSentences } from "@/services/language/sentences";

describe("commitUtterance", () => {
  it("appends each utterance on the same line — never a line break", () => {
    let box = "";
    box = commitUtterance(box, "今日は暑いですね");
    box = commitUtterance(box, "そうですね");
    expect(box).toBe("今日は暑いですねそうですね");
    expect(box).not.toContain("\n");
  });

  it("does not put a 。 (or any mark) into Japanese text", () => {
    // A pause is evidence of a boundary, not of WHICH mark belongs there — and a
    // wrong one gets baked into text the user goes on to save.
    expect(commitUtterance("", "行きました")).not.toMatch(/[。．.！!？?]/);
  });

  it("closes an ENGLISH utterance that ends on a word with a full stop", () => {
    // iOS gives English punctuation only in the final result, which continuous
    // dictation never sees; a pause ending a sentence is the best evidence there is.
    expect(commitUtterance("", "I went to the store")).toBe("I went to the store.");
    expect(commitUtterance("I went to the store.", "then I came home")).toBe(
      "I went to the store. then I came home.",
    );
  });

  it("leaves an English utterance alone when the recognizer already punctuated it", () => {
    expect(commitUtterance("", "Did it rain?")).toBe("Did it rain?");
    expect(commitUtterance("", "It rained,")).toBe("It rained,");
  });

  it("adds no full stop after a pause on a function word — the sentence is unfinished", () => {
    expect(commitUtterance("", "I went to the")).toBe("I went to the");
    expect(commitUtterance("I went to the", "store")).toBe("I went to the store.");
    expect(commitUtterance("", "and")).toBe("and");
  });

  it("does not double a late full stop onto one it already added", () => {
    const box = commitUtterance("", "It rained");
    expect(commitUtterance(box, ". Then it stopped")).toBe("It rained. Then it stopped.");
  });

  it("continues from text that was already in the box", () => {
    expect(commitUtterance("先に書いた文。", "話した文")).toBe("先に書いた文。話した文");
  });

  it("keeps a line break the USER typed", () => {
    expect(commitUtterance("見出し\n", "話した文")).toBe("見出し\n話した文");
  });

  it("drops an empty utterance", () => {
    // Recognizers emit one when a pause brought no speech.
    const box = commitUtterance("猫が好き", "");
    expect(commitUtterance(box, "   ")).toBe(box);
  });

  it("separates Latin-script utterances with a space", () => {
    const box = commitUtterance("", "It rained.");
    expect(commitUtterance(box, "Then it stopped.")).toBe("It rained. Then it stopped.");
    expect(commitUtterance("well", "maybe")).toBe("well maybe.");
  });

  it("splits into sentences on the recognizer's own punctuation", () => {
    let box = commitUtterance("", "今日は雨です。");
    box = commitUtterance(box, "明日は晴れます。");
    expect(box).toBe("今日は雨です。明日は晴れます。");
    expect(splitSentences(box).map((s) => s.text)).toEqual(["今日は雨です。", "明日は晴れます。"]);
  });
});

describe("recognizer punctuation (iOS addsPunctuation)", () => {
  // iOS often adds the mark that closes an utterance only once the NEXT words arrive,
  // so it lands at the head of the next utterance. It belongs to the text it closes.
  it("moves a leading 。 back onto the end of the previous utterance", () => {
    let box = commitUtterance("", "今日は雨です");
    box = commitUtterance(box, "。明日は晴れます。");
    expect(box).toBe("今日は雨です。明日は晴れます。");
    expect(splitSentences(box).map((s) => s.text)).toEqual(["今日は雨です。", "明日は晴れます。"]);
  });

  it("does the same while the next utterance is still forming", () => {
    const box = commitUtterance("", "本当");
    expect(withPartial(box, "？そうか")).toBe("本当？そうか");
  });

  it("an utterance that is ONLY the late mark closes the text and adds nothing", () => {
    const box = commitUtterance("", "行きました");
    expect(commitUtterance(box, "。")).toBe("行きました。");
  });

  it("does not double a mark the text already has", () => {
    const box = commitUtterance("", "行きました。");
    expect(commitUtterance(box, "。次")).toBe("行きました。次");
  });

  it("drops a leading mark when there is nothing for it to close", () => {
    expect(commitUtterance("", "。こんにちは")).toBe("こんにちは");
  });

  it("puts a late mark BEFORE a line break the user typed", () => {
    expect(commitUtterance("行きました\n", "。次")).toBe("行きました。\n次");
  });

  it("leaves an OPENING bracket on the utterance it opens", () => {
    const box = commitUtterance("", "彼は言った");
    expect(commitUtterance(box, "「行こう」")).toBe("彼は言った「行こう」");
  });
});

describe("withPartial", () => {
  it("shows the forming utterance after everything committed", () => {
    const box = commitUtterance("", "こんにちは");
    expect(withPartial(box, "げん")).toBe("こんにちはげん");
  });

  it("REPLACES the previous partial rather than appending to it", () => {
    // The recognizer re-sends the whole utterance as it grows; appending would
    // produce げんげんきげんきです.
    const box = commitUtterance("", "こんにちは");
    const a = withPartial(box, "げん");
    const b = withPartial(box, "げんき");
    expect(b).toBe("こんにちはげんき");
    expect(b.startsWith(a)).toBe(true); // grew, not concatenated twice
  });

  it("continues a line that paused on a comma", () => {
    expect(withPartial("明日は、", "晴れ")).toBe("明日は、晴れ");
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
