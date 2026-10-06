// @vitest-environment jsdom
// Focused hook spec for useTranslate: the applyReview state-sync callback (the
// text-quiz uses it to mark a word saved/graded in the reader without
// re-translating), plus the default translate direction (input = learning
// language, output = native language). The heavy service boundary is mocked so
// the hook mounts without touching the network; the real language registry is
// kept for its constants.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

vi.mock("@/services/lookup", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/lookup")>()),
  lookupWord: vi.fn(),
  lookupWordsBatch: vi.fn(),
  translateParagraph: vi.fn(),
}));
vi.mock("@/services/translation", () => ({ translate: vi.fn(), MAX_TRANSLATION_CONCURRENCY: 6 }));
vi.mock("@/services/words/userWords", () => ({
  saveDictionaryWord: vi.fn(),
  saveDictionaryWords: vi.fn(),
  createCustomWord: vi.fn(),
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
import { createCustomWord, getUserWordStates, saveDictionaryWords } from "@/services/words/userWords";
import { listUserLists } from "@/services/lists";
import { getUserLimits, DEFAULT_LIMITS } from "@/services/entitlements";
import { getUserLevel } from "@/services/calibration";
import { getUserProfile, updateUserLanguages } from "@/services/session";
import { DEFAULT_LEARNING_LANGUAGE, DEFAULT_NATIVE_LANGUAGE, analyze } from "@/services/language";
import { lookupWord, translateParagraph } from "@/services/lookup";

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

describe("useTranslate — emptying the box drops its result", () => {
  const TEXT = "猫が走った。犬が寝た。";
  const TOKENS = [
    { text: "猫", start: 0, end: 1, reading: null, lemma: "猫", pos: "名詞" },
    { text: "走っ", start: 2, end: 4, reading: null, lemma: "走る", pos: "動詞" },
    { text: "犬", start: 6, end: 7, reading: null, lemma: "犬", pos: "名詞" },
    { text: "寝", start: 8, end: 9, reading: null, lemma: "寝る", pos: "動詞" },
  ];

  beforeEach(() => {
    vi.mocked(getUserWordStates).mockResolvedValue(new Map());
    vi.mocked(analyze).mockResolvedValue(TOKENS as never);
    vi.mocked(translateParagraph).mockResolvedValue({
      input: TEXT,
      tokens: TOKENS,
      meanings: new Map(),
      sentences: [],
    } as never);
  });

  // A submitted paragraph used to outlive its text, and the live reader yields to a
  // submitted result — so after clearing the box, new dictation never showed.
  it("returns to idle with no paragraph once the box is cleared", async () => {
    const { result } = renderHook(() => useTranslate("user-1"));
    act(() => result.current.setInput(TEXT));
    await act(async () => {
      await result.current.submit();
    });
    await waitFor(() => expect(result.current.para).not.toBeNull());
    expect(result.current.status).toBe("done");

    act(() => result.current.setInput(""));
    expect(result.current.status).toBe("idle");
    expect(result.current.para).toBeNull();
    expect(result.current.analyzedInput).toBe("");
  });

  it("keeps a result that was submitted without ever filling the box", async () => {
    // The article analysis submits its text by override and leaves the box alone.
    const { result } = renderHook(() => useTranslate("user-1"));
    await act(async () => {
      await result.current.submit({ text: TEXT, skipGloss: true });
    });
    await waitFor(() => expect(result.current.para).not.toBeNull());
    expect(result.current.status).toBe("done");
  });
});

// Pressing Translate closes a sentence left open — dictation in particular ends bare,
// because iOS only places the last 。 once more words arrive.
describe("useTranslate — Translate closes an open sentence with a full stop", () => {
  const SENTENCE = [
    { text: "猫", start: 0, end: 1, reading: null, lemma: "猫", pos: "名詞" },
    { text: "走っ", start: 2, end: 4, reading: null, lemma: "走る", pos: "動詞" },
  ];
  const paragraph = () =>
    vi.mocked(translateParagraph).mockResolvedValue({ input: "", tokens: SENTENCE, meanings: new Map(), sentences: [] } as never);

  beforeEach(() => {
    vi.mocked(getUserWordStates).mockResolvedValue(new Map());
    vi.mocked(analyze).mockResolvedValue(SENTENCE as never);
    paragraph();
  });

  it("adds 。 to the box and studies the closed text", async () => {
    const { result } = renderHook(() => useTranslate("user-1"));
    act(() => result.current.setInput("猫が走った"));
    await act(async () => {
      await result.current.submit();
    });
    await waitFor(() => expect(result.current.status).toBe("done"));
    expect(result.current.input).toBe("猫が走った。");
    expect(result.current.analyzedInput).toBe("猫が走った。");
  });

  it("leaves a sentence that already ends alone", async () => {
    const { result } = renderHook(() => useTranslate("user-1"));
    act(() => result.current.setInput("猫が走った？"));
    await act(async () => {
      await result.current.submit();
    });
    await waitFor(() => expect(result.current.status).toBe("done"));
    expect(result.current.input).toBe("猫が走った？");
  });

  it("never punctuates a single word — that would turn a lookup into a paragraph", async () => {
    vi.mocked(analyze).mockResolvedValue([SENTENCE[0]] as never);
    vi.mocked(lookupWord).mockResolvedValue({ input: "猫", meanings: [] } as never);
    const { result } = renderHook(() => useTranslate("user-1"));
    act(() => result.current.setInput("猫"));
    await act(async () => {
      await result.current.submit();
    });
    await waitFor(() => expect(result.current.status).toBe("done"));
    expect(result.current.input).toBe("猫");
    expect(result.current.mode).toBe("word");
  });

  it("leaves text handed in by override (an article, OCR, history) as it came", async () => {
    const { result } = renderHook(() => useTranslate("user-1"));
    await act(async () => {
      await result.current.submit({ text: "猫が走った", skipGloss: true });
    });
    await waitFor(() => expect(result.current.status).toBe("done"));
    expect(result.current.analyzedInput).toBe("猫が走った");
  });
});

// Names (a person, place or company the dictionary doesn't know) stay in the reader and
// can be added by hand, but nothing AUTOMATIC touches them.
describe("useTranslate — names are never added or quizzed automatically", () => {
  const TEXT = "大東で猫を見た。";
  const TOKENS = [
    { text: "大東", start: 0, end: 2, reading: null, lemma: "大東", pos: "名詞", properNoun: true },
    { text: "猫", start: 3, end: 4, reading: null, lemma: "猫", pos: "名詞" },
  ];
  const word = (wordId: string, input: string, translation: string) =>
    ({ wordId, input, translation, inputReading: null, sourceLang: "JA", targetLang: "EN" }) as never;
  const paragraph = () => ({
    input: TEXT,
    tokens: TOKENS,
    meanings: new Map([
      ["大東", [word("w-daito", "大東", "Daito")]],
      ["猫", [word("w-neko", "猫", "cat")]],
    ]),
    names: new Set(["大東"]),
    sentences: [],
  });

  beforeEach(() => {
    vi.mocked(analyze).mockResolvedValue(TOKENS as never);
    vi.mocked(translateParagraph).mockResolvedValue(paragraph() as never);
  });

  const open = async () => {
    const hook = renderHook(() => useTranslate("user-1"));
    await act(async () => {
      await hook.result.current.submit({ text: TEXT, skipGloss: true });
    });
    await waitFor(() => expect(hook.result.current.para).not.toBeNull());
    return hook.result;
  };

  it("'Add all' and 'Quiz new words' leave the name out", async () => {
    vi.mocked(getUserWordStates).mockResolvedValue(new Map());
    const result = await open();
    expect(result.current.addablePrimaries.map((w) => w.wordId)).toEqual(["w-neko"]);
    expect(result.current.addableCards.map((c) => c[0].wordId)).toEqual(["w-neko"]);
    expect(result.current.addableCount).toBe(1);
  });

  it("the reader still has it — highlightable, with its meaning to add by hand", async () => {
    vi.mocked(getUserWordStates).mockResolvedValue(new Map());
    const result = await open();
    expect(result.current.para?.meanings.get("大東")?.[0].translation).toBe("Daito");
  });

  it("once the user HAS saved a name, it reviews like any other word", async () => {
    vi.mocked(getUserWordStates).mockResolvedValue(
      new Map([["w-daito", { tracked: true, userWordId: "uw1", confidenceRating: 2, lastReviewedDate: null }]]) as never,
    );
    const result = await open();
    await waitFor(() => expect(result.current.reviewablePrimaries.map((w) => w.wordId)).toEqual(["w-daito"]));
  });
});

// A person's or company's name has no dictionary row: adding it creates the user's OWN
// word (the name + its romanization), never a save-by-id.
describe("useTranslate — adding a name by hand", () => {
  const name = {
    wordId: "name:JA:田中", input: "田中", translation: "Tanaka", inputReading: "たなか",
    sourceLang: "JA", targetLang: "EN",
  } as never;
  const neko = { wordId: "w-neko", input: "猫", translation: "cat", sourceLang: "JA", targetLang: "EN" } as never;

  beforeEach(() => {
    vi.mocked(getUserWordStates).mockResolvedValue(new Map());
    vi.mocked(createCustomWord).mockResolvedValue({ userWordId: "uw-name", confidenceRating: 0 } as never);
    vi.mocked(saveDictionaryWords).mockResolvedValue([
      { userWordId: "uw-neko", dictionaryWordId: "w-neko", confidenceRating: 0 },
    ] as never);
  });

  it("saves it as a custom word and marks it saved", async () => {
    const { result } = renderHook(() => useTranslate("user-1"));
    await act(async () => {
      await result.current.addWords([name], "list-1");
    });
    expect(createCustomWord).toHaveBeenCalledWith({
      userId: "user-1", input: "田中", translation: "Tanaka", sourceLang: "JA", targetLang: "EN", listId: "list-1",
    });
    expect(saveDictionaryWords).not.toHaveBeenCalled();
    expect(result.current.saved.has("name:JA:田中")).toBe(true);
  });

  it("a mixed add sends each kind down its own path", async () => {
    const { result } = renderHook(() => useTranslate("user-1"));
    await act(async () => {
      await result.current.addWords([name, neko]);
    });
    expect(createCustomWord).toHaveBeenCalledTimes(1);
    expect(vi.mocked(saveDictionaryWords).mock.calls[0][0].words).toEqual([neko]);
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
