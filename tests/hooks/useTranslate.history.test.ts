// @vitest-environment jsdom
// Session translate history: the hook records a submission ONLY when it succeeds,
// and replaying an entry restores the direction it was translated in.
//
// The pure list mechanics (order, dedup, cap) are covered in
// tests/services/translateHistory.test.ts — this spec covers the wiring that file
// can't see: which submits get recorded, and what a replay puts back.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

vi.mock("@/services/lookup", () => ({
  lookupWord: vi.fn(),
  lookupWordsBatch: vi.fn(),
  translateParagraph: vi.fn(),
}));
vi.mock("@/services/translation", () => ({
  translate: vi.fn(),
  translateSegments: vi.fn(),
  MAX_TRANSLATION_CONCURRENCY: 6,
}));
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
import { analyze } from "@/services/language";
import { resetStickyState } from "@/hooks/useStickyState";

beforeEach(() => {
  vi.clearAllMocks();
  // The history lives in the sticky module cache, which is shared across cases.
  resetStickyState();
  vi.mocked(listUserLists).mockResolvedValue([]);
  vi.mocked(getUserLimits).mockResolvedValue(DEFAULT_LIMITS);
  vi.mocked(getUserLevel).mockResolvedValue(null);
  vi.mocked(getUserProfile).mockResolvedValue(null); // a guest: registry defaults
});

/**
 * Submit down the ECHO path (source === target): the hook returns early with
 * status "done" and makes no service calls, so it exercises the record-on-success
 * wiring without standing up the whole lookup stack.
 */
async function echoSubmit(result: { current: ReturnType<typeof useTranslate> }, text: string) {
  await act(async () => {
    await result.current.submit({ text, source: "EN", target: "EN" });
  });
}

describe("useTranslate — session history", () => {
  it("starts empty", async () => {
    const { result } = renderHook(() => useTranslate("user-1"));
    await waitFor(() => expect(result.current.history).toEqual([]));
  });

  it("records a submission once it succeeds", async () => {
    const { result } = renderHook(() => useTranslate("user-1"));
    await echoSubmit(result, "hello");

    await waitFor(() => expect(result.current.history).toHaveLength(1));
    expect(result.current.history[0]).toMatchObject({
      text: "hello",
      source: "EN",
      target: "EN",
    });
  });

  it("records the DIRECTION, not just the text", async () => {
    const { result } = renderHook(() => useTranslate("user-1"));
    await echoSubmit(result, "hello");
    await waitFor(() => expect(result.current.history).toHaveLength(1));
    // Replaying has to reproduce the original lookup, so the entry has to carry
    // the direction the text was submitted under.
    expect(result.current.history[0].source).toBe("EN");
    expect(result.current.history[0].target).toBe("EN");
  });

  it("does NOT record a submission that failed", async () => {
    // A quota 429 / oversize 413 / network drop must not leave a chip that replays
    // straight back into the same error.
    vi.mocked(analyze).mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() => useTranslate("user-1"));

    await act(async () => {
      await result.current.submit({ text: "猫", source: "JA", target: "EN" });
    });

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.history).toEqual([]);
  });

  it("keeps earlier successes when a later submit fails", async () => {
    const { result } = renderHook(() => useTranslate("user-1"));
    await echoSubmit(result, "hello");
    await waitFor(() => expect(result.current.history).toHaveLength(1));

    vi.mocked(analyze).mockRejectedValue(new Error("boom"));
    await act(async () => {
      await result.current.submit({ text: "猫", source: "JA", target: "EN" });
    });
    await waitFor(() => expect(result.current.status).toBe("error"));

    expect(result.current.history.map((e) => e.text)).toEqual(["hello"]);
  });

  it("ignores an empty submit (submit's own guard returns before recording)", async () => {
    const { result } = renderHook(() => useTranslate("user-1"));
    await act(async () => {
      await result.current.submit({ text: "   ", source: "EN", target: "EN" });
    });
    expect(result.current.history).toEqual([]);
  });

  it("replay restores the text and the direction into the visible state", async () => {
    const { result } = renderHook(() => useTranslate("user-1"));
    await echoSubmit(result, "hello");
    await waitFor(() => expect(result.current.history).toHaveLength(1));

    const entry = result.current.history[0];
    await act(async () => {
      result.current.replayHistory(entry);
    });

    // The LangBar reads source/target, so they must agree with what was replayed —
    // otherwise the bar shows one direction while another one ran.
    await waitFor(() => expect(result.current.input).toBe("hello"));
    expect(result.current.source).toBe("EN");
    expect(result.current.target).toBe("EN");
  });

  it("clearHistory empties the list", async () => {
    const { result } = renderHook(() => useTranslate("user-1"));
    await echoSubmit(result, "hello");
    await waitFor(() => expect(result.current.history).toHaveLength(1));

    await act(async () => {
      result.current.clearHistory();
    });
    expect(result.current.history).toEqual([]);
  });
});
