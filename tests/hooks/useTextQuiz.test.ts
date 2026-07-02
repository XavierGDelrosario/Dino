// @vitest-environment jsdom
// Hook spec for useTextQuiz — the extract-and-quiz session over NEW words in a
// pasted text. Each grade SAVES the word then records the first review (seeding
// SRS by how you scored it) and fires onGraded so the reader can sync. When
// calibrate is on, finishing estimates + persists the user's level silently.
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

beforeEach(() => {
  vi.clearAllMocks();
  // saveDictionaryWord returns a UserWord; the hook only reads userWordId +
  // confidenceRating, so return a minimal object per call keyed to the word.
  mockSave.mockImplementation(({ word }) =>
    Promise.resolve({ userWordId: `uw-${word.wordId}`, confidenceRating: 0 } as never),
  );
  mockRecord.mockResolvedValue({ userWordId: "x", confidenceRating: 4, stability: 1 } as never);
  mockDifficulty.mockReturnValue({ level: 3 } as never);
  mockEstimate.mockReturnValue(3 as never);
  mockSetLevel.mockResolvedValue(undefined as never);
});

describe("useTextQuiz", () => {
  it("reports empty for an empty word set", () => {
    const { result } = renderHook(() => useTextQuiz("user-1", []));
    expect(result.current.status).toBe("empty");
    expect(result.current.current).toBeNull();
  });

  it("starts reviewing the first word", () => {
    const { result } = renderHook(() => useTextQuiz("user-1", [wordA, wordB]));
    expect(result.current.status).toBe("reviewing");
    expect(result.current.current?.wordId).toBe("wa");
    expect(result.current.total).toBe(2);
  });

  it("grade saves the word, records the review, and calls onGraded", async () => {
    const onGraded = vi.fn();
    const { result } = renderHook(() => useTextQuiz("user-1", [wordA, wordB], { onGraded }));

    await act(async () => {
      await result.current.grade(5);
    });

    expect(mockSave).toHaveBeenCalledWith(expect.objectContaining({ userId: "user-1", word: wordA }));
    expect(mockRecord).toHaveBeenCalledWith({ userWordId: "uw-wa", grade: 5 });
    expect(onGraded).toHaveBeenCalledWith("wa", "uw-wa", 4);
    expect(result.current.position).toBe(2);
    expect(result.current.reviewedCount).toBe(1);
  });

  it("finishing a calibrated session estimates + persists the level", async () => {
    const { result } = renderHook(() => useTextQuiz("user-1", [wordA], { calibrate: true }));

    await act(async () => {
      await result.current.grade(2);
    });

    expect(result.current.status).toBe("done");
    expect(mockDifficulty).toHaveBeenCalledWith(wordA);
    expect(mockEstimate).toHaveBeenCalledWith([{ difficulty: 3, grade: 2 }]);
    await waitFor(() => expect(mockSetLevel).toHaveBeenCalledWith("user-1", 3));
  });

  it("does NOT calibrate when calibrate is off (default)", async () => {
    const { result } = renderHook(() => useTextQuiz("user-1", [wordA]));

    await act(async () => {
      await result.current.grade(2);
    });

    expect(result.current.status).toBe("done");
    expect(mockEstimate).not.toHaveBeenCalled();
    expect(mockSetLevel).not.toHaveBeenCalled();
  });

  it("keeps the card and surfaces the error when a save fails", async () => {
    mockSave.mockRejectedValueOnce(new Error("save failed"));
    const { result } = renderHook(() => useTextQuiz("user-1", [wordA, wordB]));

    await act(async () => {
      await result.current.grade(3);
    });

    expect(result.current.position).toBe(1);
    expect(result.current.reviewedCount).toBe(0);
    expect(result.current.error).toBeTruthy();
    expect(mockRecord).not.toHaveBeenCalled();
  });
});
