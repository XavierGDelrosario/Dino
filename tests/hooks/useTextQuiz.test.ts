// @vitest-environment jsdom
// Hook spec for useTextQuiz — the extract-and-quiz session over NEW words in a
// pasted text. Each card is a word's full SENSE LIST (primary first): the user can
// cycle meanings with next/prevMeaning and add the selected one with addCurrent (the
// ＋ button). Grading saves the SELECTED sense then records the first review
// (seeding SRS); when calibrate is on, finishing persists the user's level silently.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { makeWord } from "@test/fixtures";

vi.mock("@/services/words/userWords", () => ({ saveDictionaryWord: vi.fn() }));
vi.mock("@/services/review", () => ({ recordReview: vi.fn() }));
vi.mock("@/services/calibration", () => ({ estimateLevel: vi.fn(), setUserLevel: vi.fn() }));
vi.mock("@/services/difficulty", () => ({ getDifficulty: vi.fn() }));

import { useTextQuiz } from "@/hooks/useTextQuiz";
import { saveDictionaryWord } from "@/services/words/userWords";
import { recordReview } from "@/services/review";
import { estimateLevel, setUserLevel } from "@/services/calibration";
import { getDifficulty } from "@/services/difficulty";

const mockSave = vi.mocked(saveDictionaryWord);
const mockRecord = vi.mocked(recordReview);
const mockEstimate = vi.mocked(estimateLevel);
const mockSetLevel = vi.mocked(setUserLevel);
const mockDifficulty = vi.mocked(getDifficulty);

const wordA = makeWord({ wordId: "wa", input: "赤", translation: "red" });
const wordB = makeWord({ wordId: "wb", input: "青", translation: "blue" });
// A word with two senses (one card that can cycle meanings).
const s1 = makeWord({ wordId: "s1", input: "辛い", translation: "spicy", inputReading: "からい" });
const s2 = makeWord({ wordId: "s2", input: "辛い", translation: "painful", inputReading: "つらい" });

beforeEach(() => {
  vi.clearAllMocks();
  mockSave.mockImplementation(({ word }) =>
    Promise.resolve({ userWordId: `uw-${word.wordId}`, confidenceRating: 0 } as never),
  );
  mockRecord.mockResolvedValue({ userWordId: "x", confidenceRating: 4, stability: 1 } as never);
  mockDifficulty.mockReturnValue({ level: 3 } as never);
  mockEstimate.mockReturnValue(3 as never);
  mockSetLevel.mockResolvedValue(undefined as never);
});

describe("useTextQuiz", () => {
  it("reports empty for an empty card set", () => {
    const { result } = renderHook(() => useTextQuiz("user-1", []));
    expect(result.current.status).toBe("empty");
    expect(result.current.current).toBeNull();
  });

  it("starts on the first word's primary sense", () => {
    const { result } = renderHook(() => useTextQuiz("user-1", [[wordA], [wordB]]));
    expect(result.current.status).toBe("reviewing");
    expect(result.current.current?.wordId).toBe("wa");
    expect(result.current.total).toBe(2);
    expect(result.current.hasMultipleMeanings).toBe(false);
  });

  it("grade saves the word, records the review, and calls onGraded", async () => {
    const onGraded = vi.fn();
    const { result } = renderHook(() => useTextQuiz("user-1", [[wordA], [wordB]], { onGraded }));

    await act(async () => {
      await result.current.grade(5);
    });

    expect(mockSave).toHaveBeenCalledWith(expect.objectContaining({ userId: "user-1", word: wordA }));
    expect(mockRecord).toHaveBeenCalledWith({ userWordId: "uw-wa", grade: 5 });
    expect(onGraded).toHaveBeenCalledWith("wa", "uw-wa", 4);
    expect(result.current.position).toBe(2);
    expect(result.current.reviewedCount).toBe(1);
  });

  it("cycles meanings within a card (wraps both directions)", () => {
    const { result } = renderHook(() => useTextQuiz("user-1", [[s1, s2]]));
    expect(result.current.hasMultipleMeanings).toBe(true);
    expect(result.current.senses).toHaveLength(2);
    expect(result.current.current?.wordId).toBe("s1");

    act(() => result.current.nextMeaning());
    expect(result.current.meaningIndex).toBe(1);
    expect(result.current.current?.wordId).toBe("s2");

    act(() => result.current.nextMeaning()); // wraps back to 0
    expect(result.current.current?.wordId).toBe("s1");

    act(() => result.current.prevMeaning()); // wraps to last
    expect(result.current.current?.wordId).toBe("s2");
  });

  it("grade saves the SELECTED sense after cycling (not just the primary)", async () => {
    const { result } = renderHook(() => useTextQuiz("user-1", [[s1, s2]]));
    act(() => result.current.nextMeaning()); // select つらい (s2)

    await act(async () => {
      await result.current.grade(4);
    });

    expect(mockSave).toHaveBeenCalledWith(expect.objectContaining({ word: s2 }));
    expect(mockRecord).toHaveBeenCalledWith({ userWordId: "uw-s2", grade: 4 });
  });

  it("addCurrent (＋) adds the selected sense WITHOUT a review and marks it saved", async () => {
    const onGraded = vi.fn();
    const { result } = renderHook(() => useTextQuiz("user-1", [[s1, s2]], { onGraded }));

    await act(async () => {
      await result.current.addCurrent();
    });

    expect(mockSave).toHaveBeenCalledWith(expect.objectContaining({ word: s1 })); // the first, default
    expect(mockRecord).not.toHaveBeenCalled(); // add ≠ grade
    expect(onGraded).toHaveBeenCalledWith("s1", "uw-s1", 0);
    expect(result.current.isCurrentSaved).toBe(true);
    expect(result.current.position).toBe(1); // stays on the card
    expect(result.current.reviewedCount).toBe(0);
  });

  it("finishing a calibrated session estimates + persists the level", async () => {
    const { result } = renderHook(() => useTextQuiz("user-1", [[wordA]], { calibrate: true }));

    await act(async () => {
      await result.current.grade(2);
    });

    expect(result.current.status).toBe("done");
    expect(mockDifficulty).toHaveBeenCalledWith(wordA);
    expect(mockEstimate).toHaveBeenCalledWith([{ difficulty: 3, grade: 2 }]);
    await waitFor(() => expect(mockSetLevel).toHaveBeenCalledWith("user-1", 3));
  });

  it("does NOT calibrate when calibrate is off (default)", async () => {
    const { result } = renderHook(() => useTextQuiz("user-1", [[wordA]]));

    await act(async () => {
      await result.current.grade(2);
    });

    expect(result.current.status).toBe("done");
    expect(mockEstimate).not.toHaveBeenCalled();
    expect(mockSetLevel).not.toHaveBeenCalled();
  });

  it("keeps the card and surfaces the error when a save fails", async () => {
    mockSave.mockRejectedValueOnce(new Error("save failed"));
    const { result } = renderHook(() => useTextQuiz("user-1", [[wordA], [wordB]]));

    await act(async () => {
      await result.current.grade(3);
    });

    expect(result.current.position).toBe(1);
    expect(result.current.reviewedCount).toBe(0);
    expect(result.current.error).toBeTruthy();
    expect(mockRecord).not.toHaveBeenCalled();
  });
});
