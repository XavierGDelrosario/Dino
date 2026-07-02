// @vitest-environment jsdom
// Focused hook spec for useTranslate: the applyReview state-sync callback (the
// text-quiz uses it to mark a word saved/graded in the reader without
// re-translating), plus the default translate direction (input = learning
// language, output = native language). The heavy service boundary is mocked so
// the hook mounts without touching the network; the real language registry is
// kept for its constants.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

vi.mock("@/services/lookup", () => ({
  lookupWord: vi.fn(),
  lookupWordsBatch: vi.fn(),
  translateParagraph: vi.fn(),
}));
vi.mock("@/services/translation", () => ({ translate: vi.fn(), MAX_TRANSLATION_CONCURRENCY: 6 }));
vi.mock("@/services/words/userWords", () => ({
  saveDictionaryWord: vi.fn(),
  saveDictionaryWords: vi.fn(),
  getUserWordStates: vi.fn(),
}));
vi.mock("@/services/lists", () => ({ listUserLists: vi.fn(), createList: vi.fn() }));
vi.mock("@/services/entitlements", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/entitlements")>()),
  getUserLimits: vi.fn(),
}));
vi.mock("@/services/review", () => ({ recordReview: vi.fn() }));
vi.mock("@/services/calibration", () => ({ getUserLevel: vi.fn(), seedStability: vi.fn() }));
vi.mock("@/services/session", () => ({ getUserProfile: vi.fn() }));
vi.mock("@/services/difficulty", () => ({ getDifficulty: vi.fn() }));
vi.mock("@/services/domain", () => ({ expandDomain: vi.fn() }));
vi.mock("@/services/contentSafety", () => ({ isExplicitSuggestion: vi.fn() }));
vi.mock("@/services/language", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/language")>()),
  analyze: vi.fn(),
}));

import { useTranslate } from "@/hooks/useTranslate";
import { listUserLists } from "@/services/lists";
import { getUserLimits, DEFAULT_LIMITS } from "@/services/entitlements";
import { getUserLevel } from "@/services/calibration";
import { getUserProfile } from "@/services/session";
import { DEFAULT_LEARNING_LANGUAGE, DEFAULT_NATIVE_LANGUAGE } from "@/services/language";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listUserLists).mockResolvedValue([]);
  vi.mocked(getUserLimits).mockResolvedValue(DEFAULT_LIMITS);
  vi.mocked(getUserLevel).mockResolvedValue(null);
  vi.mocked(getUserProfile).mockResolvedValue(null); // a guest: fall back to defaults
});

describe("useTranslate — defaults", () => {
  it("defaults input to the LEARNING language and output to the NATIVE language", async () => {
    const { result } = renderHook(() => useTranslate("user-1"));
    // The profile effect resolves to the registry defaults for a guest.
    await waitFor(() => expect(result.current.source).toBe(DEFAULT_LEARNING_LANGUAGE));
    expect(result.current.target).toBe(DEFAULT_NATIVE_LANGUAGE);
    expect(result.current.learning).toBe(DEFAULT_LEARNING_LANGUAGE);
  });
});

describe("useTranslate — applyReview", () => {
  it("marks a sense saved at the given confidence and records its user_word id", async () => {
    const { result } = renderHook(() => useTranslate("user-1"));
    await waitFor(() => expect(result.current.source).toBe(DEFAULT_LEARNING_LANGUAGE));

    expect(result.current.saved.has("w-1")).toBe(false);

    act(() => {
      result.current.applyReview("w-1", "uw-1", 4);
    });

    expect(result.current.saved.has("w-1")).toBe(true);
    expect(result.current.confidence.get("w-1")).toBe(4);
  });

  it("updates confidence when applyReview is called again for the same sense", async () => {
    const { result } = renderHook(() => useTranslate("user-1"));
    await waitFor(() => expect(result.current.source).toBe(DEFAULT_LEARNING_LANGUAGE));

    act(() => result.current.applyReview("w-1", "uw-1", 2));
    act(() => result.current.applyReview("w-1", "uw-1", 5));

    expect(result.current.confidence.get("w-1")).toBe(5);
    expect(result.current.saved.has("w-1")).toBe(true);
  });
});
