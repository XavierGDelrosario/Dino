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
vi.mock("@/services/session", () => ({ getUserProfile: vi.fn(), updateUserLanguages: vi.fn() }));
vi.mock("@/services/difficulty", () => ({ getDifficulty: vi.fn() }));
vi.mock("@/services/domain", () => ({ expandDomain: vi.fn() }));
vi.mock("@/services/contentSafety", () => ({ isExplicitSuggestion: vi.fn() }));
vi.mock("@/services/language", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/language")>()),
  analyze: vi.fn(),
}));

import { useTranslate } from "@/hooks/useTranslate";
import { getUserWordStates } from "@/services/words/userWords";
import { listUserLists } from "@/services/lists";
import { getUserLimits, DEFAULT_LIMITS } from "@/services/entitlements";
import { getUserLevel } from "@/services/calibration";
import { getUserProfile, updateUserLanguages } from "@/services/session";
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

// "I'm learning: X" IS the profile's learning language, not a per-tab setting. It used
// to be local state seeded from the profile and never written back, so Learn, the
// placement quiz and Media kept reading the OLD value: switching to English here still
// dealt Japanese placement cards, with nothing on screen to explain it.
describe("useTranslate — setLearning persists to the profile", () => {
  it("writes the new learning language to the profile", async () => {
    vi.mocked(updateUserLanguages).mockResolvedValue(undefined);
    const { result } = renderHook(() => useTranslate("user-1"));
    await waitFor(() => expect(result.current.learning).toBe(DEFAULT_LEARNING_LANGUAGE));

    act(() => result.current.setLearning("EN"));

    expect(result.current.learning).toBe("EN"); // optimistic — the picker never lags
    expect(updateUserLanguages).toHaveBeenCalledWith({ userId: "user-1", learningLanguage: "EN" });
  });

  it("a profile that resolves AFTER the pick does not overwrite it", async () => {
    // The race this guards, pinned deterministically instead of left to load.
    // `prefs` opens on the registry defaults and is REPLACED when the profile lands.
    // If that lands after the user has chosen, an unguarded effect re-runs and snaps
    // the picker back — pick English fast enough after opening Translate and it
    // reverts to Japanese on its own. It also made this suite flaky: under parallel
    // load the profile resolved after the act() and the assertion saw the clobber.
    type Profile = Awaited<ReturnType<typeof getUserProfile>>;
    let landProfile!: (p: Profile) => void;
    vi.mocked(getUserProfile).mockReturnValue(
      new Promise<Profile>((resolve) => { landProfile = resolve; }),
    );
    vi.mocked(updateUserLanguages).mockResolvedValue(undefined);

    const { result } = renderHook(() => useTranslate("user-1"));
    act(() => result.current.setLearning("EN"));
    expect(result.current.learning).toBe("EN");

    // The profile now lands, and it says JA.
    await act(async () => {
      landProfile({ userId: "user-1", learningLanguage: "JA", nativeLanguage: "EN" } as Profile);
    });

    expect(result.current.learning).toBe("EN"); // the user's choice wins
  });

  it("still applies the saved profile when the user has NOT chosen", async () => {
    // The other half: the guard must not latch on the effect's first run, which
    // carries the DEFAULTS — that would mean a saved profile never applied at all.
    vi.mocked(getUserProfile).mockResolvedValue({
      userId: "user-1", learningLanguage: "EN", nativeLanguage: "JA",
    } as Awaited<ReturnType<typeof getUserProfile>>);

    const { result } = renderHook(() => useTranslate("user-1"));
    await waitFor(() => expect(result.current.learning).toBe("EN"));
  });

  it("keeps the session on the chosen language even if the write fails", async () => {
    // Not worth an error dialog mid-translation: the session behaves as asked, it just
    // won't be remembered.
    vi.mocked(updateUserLanguages).mockRejectedValue(new Error("offline"));
    const { result } = renderHook(() => useTranslate("user-1"));
    await waitFor(() => expect(result.current.learning).toBe(DEFAULT_LEARNING_LANGUAGE));

    act(() => result.current.setLearning("EN"));

    expect(result.current.learning).toBe("EN");
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

// The LIVE reader (under the input, while typing or dictating) finds its meanings on
// the free dictionary path, but the red→green colouring reads saved/confidence —
// which only submit used to fill. So a word known at 5/5 rendered blue "addable",
// which is worse than no colour at all.
describe("useTranslate — syncSenseState", () => {
  const state = (tracked: boolean, confidenceRating = 0, userWordId = "uw-1") =>
    new Map([["w-1", { tracked, confidenceRating, userWordId, lastReviewedDate: null }]]);

  const mounted = async () => {
    const { result } = renderHook(() => useTranslate("user-1"));
    await waitFor(() => expect(result.current.source).toBe(DEFAULT_LEARNING_LANGUAGE));
    return result;
  };

  it("marks a sense the user already owns, at its confidence", async () => {
    vi.mocked(getUserWordStates).mockResolvedValue(state(true, 4));
    const result = await mounted();

    await act(async () => result.current.syncSenseState(["w-1"]));

    expect(result.current.saved.has("w-1")).toBe(true);
    expect(result.current.confidence.get("w-1")).toBe(4);
  });

  it("asks about each sense ONCE — the live reader re-analyzes on every pause", async () => {
    vi.mocked(getUserWordStates).mockResolvedValue(state(false));
    const result = await mounted();

    await act(async () => result.current.syncSenseState(["w-1"]));
    await act(async () => result.current.syncSenseState(["w-1"]));

    expect(getUserWordStates).toHaveBeenCalledTimes(1);
  });

  it("MERGES — it cannot unmark what another path already saved", async () => {
    // An untracked answer must not clear a sense marked saved in the meantime, or a
    // slow response would undo the add the user just made.
    vi.mocked(getUserWordStates).mockResolvedValue(state(false));
    const result = await mounted();

    act(() => result.current.applyReview("w-1", "uw-1", 3));
    await act(async () => result.current.syncSenseState(["w-1"]));

    expect(result.current.saved.has("w-1")).toBe(true);
    expect(result.current.confidence.get("w-1")).toBe(3);
  });

  it("lets a FAILED lookup be retried rather than caching the failure", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {}); // the failure is the point
    vi.mocked(getUserWordStates).mockRejectedValueOnce(new Error("offline"));
    const result = await mounted();

    await act(async () => result.current.syncSenseState(["w-1"]));
    expect(result.current.saved.has("w-1")).toBe(false);

    vi.mocked(getUserWordStates).mockResolvedValue(state(true, 5));
    await act(async () => result.current.syncSenseState(["w-1"]));

    expect(result.current.saved.has("w-1")).toBe(true);
    expect(result.current.confidence.get("w-1")).toBe(5);
    expect(warn).toHaveBeenCalled(); // the miss was reported, not swallowed
    warn.mockRestore();
  });
});
