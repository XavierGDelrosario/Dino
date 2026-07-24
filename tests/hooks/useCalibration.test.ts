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
  resolveLevelMove: vi.fn(),
  getUserLevel: vi.fn(),
  getUserProficiencyBand: vi.fn(),
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
  resolveLevelMove,
  getUserLevel,
  getUserProficiencyBand,
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
const mockResolve = vi.mocked(resolveLevelMove);
const mockPriorLevel = vi.mocked(getUserLevel);
const mockPriorBand = vi.mocked(getUserProficiencyBand);
const mockSetLevel = vi.mocked(setUserLevel);
const mockSetBand = vi.mocked(setUserProficiencyBand);

const A = makeWord({ wordId: "a", input: "赤", translation: "red", inputReading: "あか" });
const B = makeWord({ wordId: "b", input: "青", translation: "blue", inputReading: "あお" });
const C = makeWord({ wordId: "c", input: "白", translation: "white", inputReading: "しろ" });
const D = makeWord({ wordId: "d", input: "黒", translation: "black", inputReading: "くろ" });
const E = makeWord({ wordId: "e", input: "緑", translation: "green", inputReading: "みどり" });
const F = makeWord({ wordId: "f", input: "紫", translation: "purple", inputReading: "むらさき" });
// fetchLearnWords returns cards (Word[][]); the hook takes each card's primary. Each
// round draws DIFFERENT words (the server samples the band's pool at random), and the
// hook drops any word it has already shown this session — so a mock that returned the
// same three words every round would (correctly) come back empty on round 2.
const BATCH = [[A], [B], [C]];
const BATCH_2 = [[D], [E], [F]];
const START = { lo: 1, hi: 5, best: 0, band: 3, prior: null };

beforeEach(() => {
  vi.clearAllMocks();
  mockProfile.mockResolvedValue({ learningLanguage: "JA", nativeLanguage: "EN" } as never);
  let round = 0;
  mockFetch.mockImplementation(() => Promise.resolve((round++ === 0 ? BATCH : BATCH_2) as never));
  mockStart.mockReturnValue(START as never);
  mockAdvance.mockReturnValue({ done: true, level: 3 } as never); // single-round converge by default
  mockEstimate.mockReturnValue(2 as never);
  // No stored estimates by default (a first-time calibration); the ±1 clamp is unit-
  // tested in services/calibration.test.ts, so here it just passes the measurement on.
  mockPriorBand.mockResolvedValue(null as never);
  mockPriorLevel.mockResolvedValue(null as never);
  mockResolve.mockImplementation((measured) => measured as never);
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

    expect(mockStart).toHaveBeenCalledWith(5, null); // JLPT max band, no prior
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
    mockAdvance.mockReturnValueOnce({
      done: false,
      search: { lo: 4, hi: 5, best: 3, band: 4, prior: null },
    } as never);
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
    // The round's COUNTS (2 known of 3) fold into the search — counts, not a fraction,
    // so a borderline band can pool two batches; advanced → round 2, next band fetched.
    expect(mockAdvance).toHaveBeenCalledWith(START, 2, 3);
    await waitFor(() => expect(result.current.round).toBe(2));
    expect(mockFetch).toHaveBeenLastCalledWith(
      expect.objectContaining({ band: 4, excludeSeen: true }),
    );
    await waitFor(() => expect(result.current.addedCount).toBe(2)); // from actual saves
  });

  it("on convergence persists BOTH axes and shows the JLPT label", async () => {
    mockAdvance
      .mockReturnValueOnce({
        done: false,
        search: { lo: 4, hi: 5, best: 3, band: 4, prior: null },
      } as never)
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

  // ── The stored estimate bounds a RE-calibration (the anti-swing path) ──────
  it("seeds the search from the stored band and clamps BOTH axes to within one of it", async () => {
    mockPriorBand.mockResolvedValue(3 as never); // already placed at N3
    mockPriorLevel.mockResolvedValue(3 as never);
    mockAdvance.mockReturnValue({ done: true, level: 5 } as never); // a wild measurement
    mockEstimate.mockReturnValue(5 as never);
    mockResolve.mockReturnValue(4 as never); // …which resolveLevelMove caps at prior + 1

    const { result } = renderHook(() => useCalibration("u"));
    await waitFor(() => expect(result.current.status).toBe("reviewing"));
    expect(mockStart).toHaveBeenCalledWith(5, 3); // search spans the prior, not 1..5

    act(() => result.current.submit());
    await waitFor(() => expect(result.current.status).toBe("done"));

    // Every persisted value goes through the clamp, with the prior for THAT axis.
    expect(mockResolve).toHaveBeenCalledWith(5, 3); // band: measured 5 vs prior band 3
    expect(mockResolve).toHaveBeenCalledWith(5, 3); // level: estimate 5 vs prior level 3
    expect(mockSetBand).toHaveBeenCalledWith("u", 4);
    expect(mockSetLevel).toHaveBeenCalledWith("u", 4);
  });

  it("a first-time user who is credited nothing stays cold-start (level null)", async () => {
    mockEstimate.mockReturnValue(null as never); // no level cleared the threshold
    mockAdvance.mockReturnValue({ done: true, level: 1 } as never);
    const { result } = renderHook(() => useCalibration("u"));
    await waitFor(() => expect(result.current.status).toBe("reviewing"));

    act(() => result.current.submit());
    await waitFor(() => expect(result.current.status).toBe("done"));
    expect(mockSetLevel).toHaveBeenCalledWith("u", null); // NOT clamped to 1
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
