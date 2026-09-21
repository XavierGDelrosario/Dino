// @vitest-environment jsdom
// A PINNED language pair has to win on the FIRST render.
//
// Every pinned surface (ArticleView, reached from Learn → Media → Study) calls
// `submit` from its OWN mount effect. While the pin was merely written into state by
// an effect, that `set` landed in the NEXT commit and the `submit` of the mount commit
// still closed over the profile's languages — so the pin never reached the one call it
// exists for.
//
// What that cost: for an English article `learning` still read JA, so submit took its
// "translate the input INTO the language you're learning and study THAT" branch. The
// article was machine-translated to Japanese — a paid, whole-article MT call — and the
// word table then listed JAPANESE vocabulary for an English news story.
//
// So the two halves are pinned separately: the render-time values (the cause, which is
// invisible to anything that waits for effects to settle) and what a mount-effect
// caller actually gets (the consequence).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useEffect } from "react";
import { render, renderHook, cleanup, waitFor } from "@testing-library/react";

// Partial: `wordKey` stays real — the hook keys the reader's word list with it, so a
// stub would change what the test is measuring.
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

import { useTranslate, type TranslateLangs } from "@/hooks/useTranslate";
import { translateParagraph } from "@/services/lookup";
import { translate } from "@/services/translation";
import { getUserWordStates } from "@/services/words/userWords";
import { listUserLists } from "@/services/lists";
import { getUserLimits, DEFAULT_LIMITS } from "@/services/entitlements";
import { getUserLevel } from "@/services/calibration";
import { getUserProfile } from "@/services/session";
import { analyze } from "@/services/language";

// An English news sentence — long enough that submit reads it as a paragraph.
const ARTICLE = "The council approved the new bridge on Tuesday after a long debate.";
const EN_TOKENS = ARTICLE.split(" ").map((w, i) => ({
  text: w,
  start: i,
  end: i + 1,
  reading: null,
  lemma: w,
  pos: "NOUN",
}));

// Learn's picker on English → Media browses en.wikinews → Study. `native` is JA
// because the profile's native language (EN) is the one being learned here.
const EN_ARTICLE_PAIR: TranslateLangs = { learning: "EN", native: "JA" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listUserLists).mockResolvedValue([]);
  vi.mocked(getUserLimits).mockResolvedValue(DEFAULT_LIMITS);
  vi.mocked(getUserLevel).mockResolvedValue(null);
  vi.mocked(getUserWordStates).mockResolvedValue(new Map());
  // The profile says JA — the EN-native default, and the value the stale closure read.
  vi.mocked(getUserProfile).mockResolvedValue({ learningLanguage: "JA", nativeLanguage: "EN" } as never);
  vi.mocked(analyze).mockResolvedValue(EN_TOKENS as never);
  vi.mocked(translateParagraph).mockResolvedValue({
    input: ARTICLE,
    tokens: EN_TOKENS,
    meanings: new Map(),
    sentences: [],
  } as never);
});

afterEach(cleanup);

/**
 * ArticleView's shape, reduced to the part that matters: the pinned pair goes in, and
 * `submit` is called from this component's own mount effect — the same commit. Using
 * the real component here would drag in the whole analysis UI to prove a thing about
 * one commit's closures.
 */
function MountSubmitter({ langs }: { langs: TranslateLangs }) {
  const t = useTranslate("user-1", langs);
  useEffect(() => {
    void t.submit({ text: ARTICLE, skipGloss: true, source: langs.learning, target: langs.native });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

describe("useTranslate — a pinned pair wins on the first render", () => {
  it("carries the pinned pair in the mount render itself, not one commit later", () => {
    const perRender: Array<{ learning: string; source: string; target: string }> = [];
    renderHook(() => {
      const t = useTranslate("user-1", EN_ARTICLE_PAIR);
      perRender.push({ learning: t.learning, source: t.source, target: t.target });
      return t;
    });
    // Deliberately NOT the settled value: anything that waits for effects sees the
    // right answer either way, which is why this went unnoticed. The mount render is
    // the one whose `submit` a pinned surface calls.
    expect(perRender[0]).toEqual({ learning: "EN", source: "EN", target: "JA" });
  });

  it("studies an English article AS English, in the EN→JA direction", async () => {
    render(<MountSubmitter langs={EN_ARTICLE_PAIR} />);
    await waitFor(() => expect(translateParagraph).toHaveBeenCalled());
    expect(vi.mocked(translateParagraph).mock.calls[0][0]).toMatchObject({
      input: ARTICLE,
      sourceLang: "EN",
      targetLang: "JA",
    });
    // The English text itself is what gets segmented — not a Japanese rendering of it.
    expect(vi.mocked(analyze).mock.calls[0]).toEqual([ARTICLE, "EN"]);
  });

  it("does not buy an MT translation of the article into the profile's language", async () => {
    render(<MountSubmitter langs={EN_ARTICLE_PAIR} />);
    await waitFor(() => expect(translateParagraph).toHaveBeenCalled());
    // The regression that cost real money: the "translate the input INTO the language
    // you're learning" branch sent the WHOLE article to paid MT.
    expect(translate).not.toHaveBeenCalled();
  });

  it("the profile never leaks into a pinned instance, however late it resolves", async () => {
    const { result } = renderHook(() => useTranslate("user-1", EN_ARTICLE_PAIR));
    await waitFor(() => expect(getUserProfile).toHaveBeenCalled());
    expect(result.current.learning).toBe("EN");
    expect(result.current.source).toBe("EN");
    expect(result.current.target).toBe("JA");
  });
});
