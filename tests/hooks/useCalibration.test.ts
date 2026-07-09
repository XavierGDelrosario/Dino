// @vitest-environment jsdom
// Hook spec for useCalibration — the adaptive "Find my level" placement quiz.
// Each round shows a batch at one band; the user taps the words they DON'T know;
// submit folds the known-fraction into a binary search (mocked here — the real
// algorithm is covered in services/calibration.test.ts) and, on convergence,
// persists BOTH axes: the JLPT band → users.proficiency_band, and estimateLevel()
// over the tested words' frequency → users.level. Known words are also added to
// the vocabulary at full confidence (initialStability 40).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { makeWord } from "@test/fixtures";

vi.mock("@/services/session", () => ({ getUserProfile: vi.fn() }));
vi.mock("@/services/learn", () => ({ fetchLearnWords: vi.fn() }));
vi.mock("@/services/words/userWords", () => ({ saveDictionaryWords: vi.fn() }));
vi.mock("@/services/difficulty", () => ({ getDifficulty: vi.fn() }));
// Mock the calibration service: the PURE search fns are driven per-test (the real
// ones are unit-tested separately); the persistence fns are spies.
vi.mock("@/services/calibration", () => ({
  startBandSearch: vi.fn(),
  advanceBandSearch: vi.fn(),
  estimateLevel: vi.fn(),
  setUserLevel: vi.fn(),
  setUserProficiencyBand: vi.fn(),
}));
// services/proficiency stays REAL (pure registry, no Supabase) so labelForBand /
// proficiencyFrameworkFor resolve the actual JLPT bands.

import { useCalibration, CALIBRATION_BATCH } from "@/hooks/useCalibration";
import { getUserProfile } from "@/services/session";
import { fetchLearnWords } from "@/services/learn";
import { saveDictionaryWords } from "@/services/words/userWords";
import { getDifficulty } from "@/services/difficulty";
import {
  startBandSearch,
  advanceBandSearch,
  estimateLevel,
  setUserLevel,
  setUserProficiencyBand,
} from "@/services/calibration";

const mockProfile = vi.mocked(getUserProfile);
const mockFetch = vi.mocked(fetchLearnWords);
const mockSave = vi.mocked(saveDictionaryWords);
const mockDifficulty = vi.mocked(getDifficulty);
const mockStart = vi.mocked(startBandSearch);
const mockAdvance = vi.mocked(advanceBandSearch);
const mockEstimate = vi.mocked(estimateLevel);
const mockSetLevel = vi.mocked(setUserLevel);
const mockSetBand = vi.mocked(setUserProficiencyBand);

const A = makeWord({ wordId: "a", input: "赤", translation: "red", inputReading: "あか" });
const B = makeWord({ wordId: "b", input: "青", translation: "blue", inputReading: "あお" });
const C = makeWord({ wordId: "c", input: "白", translation: "white", inputReading: "しろ" });
// fetchLearnWords returns cards (Word[][]); the hook takes each card's primary.
const BATCH = [[A], [B], [C]];
const START = { lo: 1, hi: 5, best: 0, band: 3 };

beforeEach(() => {
  vi.clearAllMocks();
  mockProfile.mockResolvedValue({ learningLanguage: "JA", nativeLanguage: "EN" } as never);
  mockFetch.mockResolvedValue(BATCH as never);
  mockStart.mockReturnValue(START as never);
  mockAdvance.mockReturnValue({ done: true, level: 3 } as never); // single-round converge by default
  mockEstimate.mockReturnValue(2 as never);
  mockSetLevel.mockResolvedValue(undefined as never);
  mockSetBand.mockResolvedValue(undefined as never);
  mockDifficulty.mockReturnValue({ level: 2 } as never);
  // Batch save echoes back one row per word, so addedCount tracks real saves.
  mockSave.mockImplementation(({ words }) =>
    Promise.resolve(words.map((w) => ({ userWordId: `uw-${w.wordId}` })) as never),
  );
});

describe("useCalibration", () => {
  it("loads the starting band's batch on mount and enters reviewing", async () => {
    const { result } = renderHook(() => useCalibration("u"));
    await waitFor(() => expect(result.current.status).toBe("reviewing"));

    expect(mockStart).toHaveBeenCalledWith(5); // JLPT max band
    expect(mockFetch).toHaveBeenCalledWith({
      band: 3, source: "JA", target: "EN", limit: CALIBRATION_BATCH, excludeSeen: true,
    });
    expect(result.current.cards).toHaveLength(3);
    expect(result.current.round).toBe(1);
  });

  it("shows 'unavailable' when the first band returns no words", async () => {
    mockFetch.mockResolvedValue([] as never);
    const { result } = renderHook(() => useCalibration("u"));
    await waitFor(() => expect(result.current.status).toBe("unavailable"));
  });

  it("shows 'unavailable' (and never fetches) when the language has no framework", async () => {
    mockProfile.mockResolvedValue({ learningLanguage: "XX", nativeLanguage: "EN" } as never);
    const { result } = renderHook(() => useCalibration("u"));
    await waitFor(() => expect(result.current.status).toBe("unavailable"));
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("toggles a card's 'don't know' state", async () => {
    const { result } = renderHook(() => useCalibration("u"));
    await waitFor(() => expect(result.current.status).toBe("reviewing"));

    act(() => result.current.toggle(1));
    expect(result.current.unknown.has(1)).toBe(true);
    expect(result.current.unknownCount).toBe(1);
    act(() => result.current.toggle(1));
    expect(result.current.unknown.has(1)).toBe(false);
    expect(result.current.unknownCount).toBe(0);
  });

  it("submit adds KNOWN words at full-confidence seed, skips the unknown one, and advances", async () => {
    mockAdvance.mockReturnValueOnce({ done: false, search: { lo: 4, hi: 5, best: 3, band: 4 } } as never);
    const { result } = renderHook(() => useCalibration("u"));
    await waitFor(() => expect(result.current.status).toBe("reviewing"));

    act(() => result.current.toggle(1)); // mark B (index 1) unknown
    act(() => result.current.submit());

    // Known = A and C, saved in ONE batch at the full-confidence seed; B excluded.
    expect(mockSave).toHaveBeenCalledTimes(1);
    const arg = mockSave.mock.calls[0][0];
    expect(arg.userId).toBe("u");
    expect(arg.words).toEqual([A, C]);
    expect(arg.seedFor?.(A)).toBe(40); // initialStability 40 → confidence 5
    // knownFraction = 2/3 folded into the search; advanced → round 2, next band fetched.
    expect(mockAdvance).toHaveBeenCalledWith(START, 2 / 3);
    await waitFor(() => expect(result.current.round).toBe(2));
    expect(mockFetch).toHaveBeenLastCalledWith(
      expect.objectContaining({ band: 4, excludeSeen: true }),
    );
    await waitFor(() => expect(result.current.addedCount).toBe(2)); // from actual saves
  });

  it("on convergence persists BOTH axes and shows the JLPT label", async () => {
    mockAdvance
      .mockReturnValueOnce({ done: false, search: { lo: 4, hi: 5, best: 3, band: 4 } } as never)
      .mockReturnValueOnce({ done: true, level: 4 } as never);
    const { result } = renderHook(() => useCalibration("u"));
    await waitFor(() => expect(result.current.status).toBe("reviewing"));

    act(() => result.current.submit()); // round 1: all 3 known
    await waitFor(() => expect(result.current.round).toBe(2));
    act(() => result.current.submit()); // round 2 → converge

    await waitFor(() => expect(result.current.status).toBe("done"));
    // Proficiency axis → the band; difficulty axis → estimateLevel over the samples.
    expect(mockSetBand).toHaveBeenCalledWith("u", 4);
    expect(mockEstimate).toHaveBeenCalledWith(
      Array(6).fill({ difficulty: 2, grade: 5 }), // 3 + 3 known words, all difficulty 2
    );
    expect(mockSetLevel).toHaveBeenCalledWith("u", 2); // estimateLevel's return
    expect(result.current.levelLabel).toBe("N2"); // JLPT band 4 (1=N5 … 5=N1)
    await waitFor(() => expect(result.current.addedCount).toBe(6)); // 3 + 3 actual saves
  });

  it("records an unknown word as grade 1 in the difficulty samples", async () => {
    mockAdvance.mockReturnValueOnce({ done: true, level: 1 } as never);
    const { result } = renderHook(() => useCalibration("u"));
    await waitFor(() => expect(result.current.status).toBe("reviewing"));

    act(() => result.current.toggle(0)); // A unknown; B, C known
    act(() => result.current.submit());

    await waitFor(() => expect(result.current.status).toBe("done"));
    expect(mockEstimate).toHaveBeenCalledWith([
      { difficulty: 2, grade: 1 }, // A: unknown
      { difficulty: 2, grade: 5 }, // B: known
      { difficulty: 2, grade: 5 }, // C: known
    ]);
  });
});
