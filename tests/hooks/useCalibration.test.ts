// @vitest-environment jsdom
// Swipe placement quiz hook. The level is derived from vocabulary (real
// levelFromVocab), so we mock only the I/O: profile, the vocab baseline, the word
// fetch, the save, and the two persistence writes.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { makeWord } from "@test/fixtures";

vi.mock("@/services/session", () => ({ getUserProfile: vi.fn() }));
vi.mock("@/services/learn", () => ({ fetchLearnWords: vi.fn() }));
vi.mock("@/services/words/userWords", () => ({ saveDictionaryWord: vi.fn() }));
vi.mock("@/services/calibration", async (orig) => ({
  ...(await orig<typeof import("@/services/calibration")>()),
  getVocabRatings: vi.fn(),
  setUserLevel: vi.fn(),
  setUserProficiencyBand: vi.fn(),
}));

import { useCalibration } from "@/hooks/useCalibration";
import { getUserProfile } from "@/services/session";
import { fetchLearnWords } from "@/services/learn";
import { saveDictionaryWord } from "@/services/words/userWords";
import { getVocabRatings, setUserLevel, setUserProficiencyBand } from "@/services/calibration";

const mockProfile = vi.mocked(getUserProfile);
const mockFetch = vi.mocked(fetchLearnWords);
const mockSave = vi.mocked(saveDictionaryWord);
const mockRatings = vi.mocked(getVocabRatings);
const mockSetLevel = vi.mocked(setUserLevel);
const mockSetBand = vi.mocked(setUserProficiencyBand);

const word = (id: string, band: number) =>
  makeWord({ wordId: id, input: id, sourceLang: "JA", proficiencyBand: band, partOfSpeech: ["n"], frequency: 500 });

beforeEach(() => {
  vi.clearAllMocks();
  mockProfile.mockResolvedValue({ learningLanguage: "JA", nativeLanguage: "EN" } as never);
  mockRatings.mockResolvedValue({ ratings: [], maxBand: 5 });
  mockSave.mockResolvedValue({ userWordId: "uw", dictionaryWordId: "w" } as never);
  mockSetLevel.mockResolvedValue(undefined);
  mockSetBand.mockResolvedValue(undefined);
  // Each fetch hands back one distinct card so the deck fills without dupes.
  let n = 0;
  mockFetch.mockImplementation(async () => [[word(`w${n++}`, 3)]]);
});

describe("useCalibration (swipe placement)", () => {
  it("loads a card and enters swiping", async () => {
    const { result } = renderHook(() => useCalibration("u"));
    await waitFor(() => expect(result.current.status).toBe("swiping"));
    expect(result.current.current).toBeDefined();
  });

  it("rate(true) saves the word at the full-confidence seed and advances", async () => {
    const { result } = renderHook(() => useCalibration("u"));
    await waitFor(() => expect(result.current.status).toBe("swiping"));
    const first = result.current.current!.wordId;
    act(() => result.current.rate(true));
    expect(mockSave).toHaveBeenCalledWith(expect.objectContaining({ userId: "u", initialStability: 40 }));
    await waitFor(() => expect(result.current.current?.wordId).not.toBe(first));
    expect(result.current.known).toBe(1);
  });

  it("rate(false) saves the word to the vocabulary as a cold start (no seed)", async () => {
    const { result } = renderHook(() => useCalibration("u"));
    await waitFor(() => expect(result.current.status).toBe("swiping"));
    act(() => result.current.rate(false));
    expect(mockSave).toHaveBeenCalledWith(expect.objectContaining({ initialStability: undefined }));
    expect(result.current.unknown).toBe(1);
  });

  it("finish commits BOTH axes and shows the result", async () => {
    const { result } = renderHook(() => useCalibration("u"));
    await waitFor(() => expect(result.current.status).toBe("swiping"));
    act(() => result.current.finish());
    expect(result.current.status).toBe("done");
    expect(mockSetBand).toHaveBeenCalledTimes(1);
    expect(mockSetLevel).toHaveBeenCalledTimes(1);
  });

  it("is 'unavailable' when there's no framework/vocab for the language", async () => {
    mockRatings.mockResolvedValue(null);
    const { result } = renderHook(() => useCalibration("u"));
    await waitFor(() => expect(result.current.status).toBe("unavailable"));
  });
});
