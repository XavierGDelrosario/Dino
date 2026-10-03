import { describe, expect, it } from "vitest";
import { splitSentences } from "@/services/language/sentences";

/** Every returned span must slice back to its own text, so the reader can use
 *  the offsets to group tokens without re-deriving anything. */
function assertSpansMatch(text: string) {
  for (const s of splitSentences(text)) {
    expect(text.slice(s.start, s.end)).toBe(s.text);
  }
}

describe("splitSentences", () => {
  it("splits Japanese on 。 and keeps the terminator with its sentence", () => {
    const text = "年金制度が改正された。施行は来年4月からとなる。";
    expect(splitSentences(text).map((s) => s.text)).toEqual([
      "年金制度が改正された。",
      "施行は来年4月からとなる。",
    ]);
    assertSpansMatch(text);
  });

  it("does not split a decimal point but does split a real full stop", () => {
    expect(splitSentences("It rose 3.14 percent. Then it fell.").map((s) => s.text)).toEqual([
      "It rose 3.14 percent.",
      "Then it fell.",
    ]);
  });

  it("keeps closing brackets and quotes on the sentence they close", () => {
    const text = "彼は「行くよ。」と言った。";
    expect(splitSentences(text).map((s) => s.text)).toEqual(["彼は「行くよ。」と言った。"]);
    assertSpansMatch(text);
  });

  it("absorbs a run of terminators rather than emitting empty sentences", () => {
    expect(splitSentences("本当に!?　そうか。").map((s) => s.text)).toEqual(["本当に!?", "そうか。"]);
  });

  it("treats a hard line break as the boundary when the text has no punctuation", () => {
    const text = "今日は暑いですね\nそうですね\n";
    expect(splitSentences(text).map((s) => s.text)).toEqual(["今日は暑いですね", "そうですね"]);
    assertSpansMatch(text);
  });

  it("merges an unterminated line into the punctuated sentence it runs into", () => {
    // The reader hangs a sentence's English on its terminator; a line that ends only
    // at a break has none, so it is read with the sentence that follows it.
    const text = "横浜の銀行で\n強盗未遂があった。警官が発砲した。";
    expect(splitSentences(text).map((s) => s.text)).toEqual([
      "横浜の銀行で\n強盗未遂があった。",
      "警官が発砲した。",
    ]);
    assertSpansMatch(text);
  });

  it("carries several unterminated lines into the same sentence", () => {
    expect(splitSentences("一\n二\n三。").map((s) => s.text)).toEqual(["一\n二\n三。"]);
  });

  it("does not merge across a blank line (a headline stays out of the body)", () => {
    const text = "横浜の銀行で強盗未遂\n\n警官が発砲した。";
    expect(splitSentences(text).map((s) => s.text)).toEqual([
      "横浜の銀行で強盗未遂",
      "警官が発砲した。",
    ]);
    assertSpansMatch(text);
  });

  it("leaves a trailing unterminated line as its own sentence", () => {
    expect(splitSentences("一つ目。\n二つ目").map((s) => s.text)).toEqual(["一つ目。", "二つ目"]);
  });

  it("drops whitespace-only runs and never returns an empty sentence", () => {
    const out = splitSentences("  \n\n 一つ目。 \n\n  二つ目。  \n ");
    expect(out.map((s) => s.text)).toEqual(["一つ目。", "二つ目。"]);
    expect(out.every((s) => s.text.trim().length > 0)).toBe(true);
  });

  it("returns a single sentence for unterminated text, and nothing for blank", () => {
    expect(splitSentences("終わりのない文").map((s) => s.text)).toEqual(["終わりのない文"]);
    expect(splitSentences("   \n  ")).toEqual([]);
    expect(splitSentences("")).toEqual([]);
  });

  it("returns non-overlapping spans in reading order", () => {
    const out = splitSentences("一。二。三。");
    for (let i = 1; i < out.length; i++) expect(out[i].start).toBeGreaterThanOrEqual(out[i - 1].end);
  });
});
