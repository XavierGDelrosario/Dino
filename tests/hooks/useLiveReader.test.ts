// @vitest-environment jsdom
// The live reader's SPENDING and TIMING rules — the two ways this feature could go
// wrong. It must never buy MT (it runs on text nobody asked to translate), and it
// must not analyze text that is still being typed or still being converted by an
// IME. What it renders is ParagraphReader's job, already covered elsewhere.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

vi.mock("@/services/lookup", () => ({ translateParagraph: vi.fn() }));
vi.mock("@/services/translation/client", () => ({ translateSegments: vi.fn() }));

import { translateParagraph } from "@/services/lookup";
import { translateSegments } from "@/services/translation/client";
import { __clearGlossCache } from "@/services/translation/sentenceCache";
import { useLiveReader, completedPrefix } from "@/hooks/useLiveReader";

const mockAnalyze = vi.mocked(translateParagraph);
const mockSegments = vi.mocked(translateSegments);
const result = (tokens: unknown[] = []) => ({
  translation: "",
  translated: false,
  sourceLang: "JA",
  targetLang: "EN",
  tokens,
  meanings: new Map(),
  sentences: [],
});

const render = (text: string) =>
  renderHook(({ t }: { t: string }) => useLiveReader({ text: t, source: "JA", learning: "JA" }), {
    initialProps: { t: text },
  });

describe("completedPrefix", () => {
  it("stops at the last terminator — the sentence being typed is not included", () => {
    expect(completedPrefix("猫が好き。犬も")).toBe("猫が好き。");
    expect(completedPrefix("猫が好き。犬も好き。")).toBe("猫が好き。犬も好き。");
  });

  it("is empty until the FIRST sentence is finished", () => {
    expect(completedPrefix("猫が好き")).toBe("");
    expect(completedPrefix("")).toBe("");
  });

  // Dictation commits every utterance with a trailing "\n" and never a 。, so if a
  // line break didn't count as finished, the reader lagged one utterance behind and
  // a single spoken line rendered nothing.
  // The prefix ends at the last span's end, so the terminating break itself is
  // trimmed off — what matters is that the LINE is included at all.
  it("treats a hard line break as finished — one dictated line is enough", () => {
    expect(completedPrefix("猫が好き\n")).toBe("猫が好き");
    expect(completedPrefix("猫が好き\n犬も好き\n")).toBe("猫が好き\n犬も好き");
  });

  it("still excludes the utterance currently forming after a line break", () => {
    expect(completedPrefix("猫が好き\n犬も")).toBe("猫が好き");
  });
});

describe("useLiveReader", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockAnalyze.mockReset();
    mockAnalyze.mockResolvedValue(result() as never);
  });
  afterEach(() => vi.useRealTimers());

  it("analyzes DICTIONARY-ONLY with no gloss — a half-typed word must not buy MT", async () => {
    render("猫が好きです。");
    await act(async () => void vi.advanceTimersByTime(600));
    expect(mockAnalyze).toHaveBeenCalledTimes(1);
    const call = mockAnalyze.mock.calls[0][0];
    expect(call.dictionaryOnly).toBe(true);
    expect(call.skipGloss).toBe(true);
    expect(call.input).toBe("猫が好きです。");
    // learning→native, never learning→learning: the dictionary is keyed that way,
    // and the wrong pair returns a reader with every word grey.
    expect(call.sourceLang).toBe("JA");
    expect(call.targetLang).toBe("EN");
  });

  it("does not analyze while a sentence is still being typed", async () => {
    render("猫が好きです"); // no terminator yet
    await act(async () => void vi.advanceTimersByTime(600));
    expect(mockAnalyze).not.toHaveBeenCalled();
  });

  it("debounces a typing burst into ONE pass", async () => {
    const { rerender } = render("猫が好きです。");
    rerender({ t: "猫が好きです。犬も" });
    rerender({ t: "猫が好きです。犬も好き。" });
    await act(async () => void vi.advanceTimersByTime(600));
    expect(mockAnalyze).toHaveBeenCalledTimes(1);
    expect(mockAnalyze.mock.calls[0][0].input).toBe("猫が好きです。犬も好き。");
  });

  it("pauses while an IME is composing, then picks up on commit", async () => {
    const { result: hook } = render("猫が好きです。");
    act(() => hook.current.setComposing(true));
    await act(async () => void vi.advanceTimersByTime(600));
    expect(mockAnalyze).not.toHaveBeenCalled();

    act(() => hook.current.setComposing(false));
    await act(async () => void vi.advanceTimersByTime(600));
    expect(mockAnalyze).toHaveBeenCalledTimes(1);
  });

  it("stays quiet when the user types their NATIVE language (that direction costs MT)", async () => {
    renderHook(() => useLiveReader({ text: "I like cats.", source: "EN", learning: "JA" }));
    await act(async () => void vi.advanceTimersByTime(600));
    expect(mockAnalyze).not.toHaveBeenCalled();
  });

  it("clears when the input is emptied", async () => {
    const { result: hook, rerender } = render("猫が好きです。");
    // waitFor would hang here: it polls on real timers, which are faked.
    await act(async () => void vi.advanceTimersByTime(600));
    expect(hook.current.para).not.toBeNull();
    rerender({ t: "" });
    expect(hook.current.para).toBeNull();
    expect(hook.current.analyzed).toBe("");
  });

  // The reader buys English the same two ways the conversation listener does, over
  // the same content-addressed cache. The property that matters is that the two
  // paths are ONE purchase: tapping sentences and then pressing the toggle must pay
  // only for what is left, in either order.
  describe("buying the English", () => {
    const SENTENCES = [
      { text: "猫が好き。", start: 0, end: 5, gloss: null },
      { text: "犬も好き。", start: 5, end: 10, gloss: null },
    ];

    const withSentences = () => {
      mockAnalyze.mockResolvedValue({ ...result(), sentences: SENTENCES } as never);
      return render("猫が好き。犬も好き。");
    };

    beforeEach(() => {
      __clearGlossCache();
      mockSegments.mockReset();
      mockSegments.mockImplementation(async ({ segments }: { segments: string[] }) =>
        segments.map((s) => `EN(${s})`),
      );
    });

    it("buys ONE sentence on a tap, and shows it on that line", async () => {
      const { result: hook } = withSentences();
      await act(async () => void vi.advanceTimersByTime(600));
      await act(async () => void (await hook.current.translateSentence(0)));

      expect(mockSegments).toHaveBeenCalledTimes(1);
      expect(mockSegments.mock.calls[0][0].segments).toEqual(["猫が好き。"]);
      expect(hook.current.para?.sentences[0].gloss).toBe("EN(猫が好き。)");
      expect(hook.current.para?.sentences[1].gloss).toBeNull(); // untouched
    });

    it("a whole-text press after a tap pays ONLY for what is left — no duplicate", async () => {
      const { result: hook } = withSentences();
      await act(async () => void vi.advanceTimersByTime(600));
      await act(async () => void (await hook.current.translateSentence(0)));
      mockSegments.mockClear();

      await act(async () => void (await hook.current.translateAll()));
      expect(mockSegments).toHaveBeenCalledTimes(1);
      // The already-bought sentence is NOT on the wire again.
      expect(mockSegments.mock.calls[0][0].segments).toEqual(["犬も好き。"]);
      expect(hook.current.para?.sentences.map((s) => s.gloss)).toEqual([
        "EN(猫が好き。)",
        "EN(犬も好き。)",
      ]);
    });

    it("a tap after a whole-text press costs nothing — the same purchase, either order", async () => {
      const { result: hook } = withSentences();
      await act(async () => void vi.advanceTimersByTime(600));
      await act(async () => void (await hook.current.translateAll()));
      mockSegments.mockClear();

      await act(async () => void (await hook.current.translateSentence(1)));
      expect(mockSegments).not.toHaveBeenCalled();
    });

    it("re-tapping a bought sentence spends nothing", async () => {
      const { result: hook } = withSentences();
      await act(async () => void vi.advanceTimersByTime(600));
      await act(async () => void (await hook.current.translateSentence(0)));
      mockSegments.mockClear();

      await act(async () => void (await hook.current.translateSentence(0)));
      expect(mockSegments).not.toHaveBeenCalled();
    });

    it("buys nothing on its own — the live reader still never spends unasked", async () => {
      withSentences();
      await act(async () => void vi.advanceTimersByTime(600));
      expect(mockSegments).not.toHaveBeenCalled();
    });
  });
});
