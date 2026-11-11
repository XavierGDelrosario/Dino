// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { quizPath, parseQuizPath, recordQuizScore, bestQuizScore } from "@/views/quizResults";

describe("quiz routes", () => {
  it("round-trips the language + id", () => {
    const path = quizPath("ja", "hiragana-a-row-check");
    expect(path).toBe("/quiz/JA/hiragana-a-row-check");
    expect(parseQuizPath(path)).toEqual({ language: "JA", id: "hiragana-a-row-check" });
  });
  it("rejects anything that isn't a quiz path", () => {
    for (const p of ["/", "/quiz", "/quiz/JA", "/quiz/JA/x/y", "/profile"]) expect(parseQuizPath(p)).toBeNull();
  });
});

describe("best quiz score", () => {
  beforeEach(() => localStorage.clear());
  it("keeps the better result by fraction correct", () => {
    recordQuizScore("JA", "q", { score: 5, total: 9 });
    recordQuizScore("JA", "q", { score: 3, total: 9 });
    expect(bestQuizScore("JA", "q")).toEqual({ score: 5, total: 9 });
    recordQuizScore("JA", "q", { score: 8, total: 9 });
    expect(bestQuizScore("JA", "q")).toEqual({ score: 8, total: 9 });
    expect(bestQuizScore("EN", "q")).toBeNull();
  });
});
