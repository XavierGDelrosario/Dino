import { describe, it, expect } from "vitest";
import { isMachineOutput } from "@/services/translation/attribution";

const dict = [{ jmdictEntryId: "1234" }];
const mt = [{ jmdictEntryId: null }];

describe("isMachineOutput — when the output box owes Google's mark", () => {
  it("a sentence's translation always does", () => {
    expect(isMachineOutput({ mode: "paragraph", input: "猫が好き。", output: "I like cats.", meanings: [] })).toBe(true);
  });

  it("an echo is not a translation", () => {
    expect(isMachineOutput({ mode: "paragraph", input: "hello there", output: "hello there ", meanings: [] })).toBe(false);
  });

  it("a dictionary meaning is not Google's", () => {
    expect(isMachineOutput({ mode: "word", input: "猫", output: "cat", meanings: dict })).toBe(false);
  });

  it("a word the dictionary lacked, translated by machine, is", () => {
    expect(isMachineOutput({ mode: "word", input: "藤井寺", output: "Fujidera", meanings: mt })).toBe(true);
  });

  it("only the PRIMARY meaning decides — it is the one in the box", () => {
    expect(isMachineOutput({ mode: "word", input: "猫", output: "cat", meanings: [...dict, ...mt] })).toBe(false);
  });

  it("an empty box owes nothing", () => {
    expect(isMachineOutput({ mode: "paragraph", input: "猫が好き。", output: "", meanings: [] })).toBe(false);
    expect(isMachineOutput({ mode: "word", input: "猫", output: "cat", meanings: [] })).toBe(false);
  });
});
