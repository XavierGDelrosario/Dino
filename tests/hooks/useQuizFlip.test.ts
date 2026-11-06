// @vitest-environment jsdom
// Hook spec for useQuizFlip — the quiz direction toggle (word → meaning → random).
// The contract that matters: a change NEVER alters the card in front of the user (it
// lands on the next card), random is a fresh toss per card, and the choice is
// remembered for the session (so the next quiz opens in it).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useQuizFlip } from "@/hooks/useQuizFlip";

beforeEach(() => {
  sessionStorage.clear();
});
afterEach(() => vi.restoreAllMocks());

describe("useQuizFlip", () => {
  it("defaults to word-first", () => {
    const { result } = renderHook(() => useQuizFlip(1));
    expect(result.current.pending).toBe("word");
    expect(result.current.reversed).toBe(false);
    expect(result.current.pendingChange).toBe(false);
  });

  it("cycles word → meaning → random → word", () => {
    const { result } = renderHook(() => useQuizFlip(1));
    act(() => result.current.cycle());
    expect(result.current.pending).toBe("meaning");
    act(() => result.current.cycle());
    expect(result.current.pending).toBe("random");
    act(() => result.current.cycle());
    expect(result.current.pending).toBe("word");
    expect(result.current.pendingChange).toBe(false); // full lap = back to what's shown
  });

  it("a change does NOT alter the current card — only arms the next one", () => {
    const { result, rerender } = renderHook(({ pos }) => useQuizFlip(pos), {
      initialProps: { pos: 1 },
    });

    act(() => result.current.cycle()); // → meaning

    expect(result.current.reversed).toBe(false); // still the card mid-recall
    expect(result.current.pendingChange).toBe(true);

    rerender({ pos: 2 });
    expect(result.current.reversed).toBe(true);
    expect(result.current.pendingChange).toBe(false);
  });

  it("random tosses a fresh face for every card", () => {
    const toss = vi.spyOn(Math, "random");
    const { result, rerender } = renderHook(({ pos }) => useQuizFlip(pos), {
      initialProps: { pos: 1 },
    });
    act(() => result.current.cycle());
    act(() => result.current.cycle()); // → random

    toss.mockReturnValue(0.2); // < 0.5 → meaning first
    rerender({ pos: 2 });
    expect(result.current.reversed).toBe(true);

    toss.mockReturnValue(0.8);
    rerender({ pos: 3 });
    expect(result.current.reversed).toBe(false);
  });

  it("remembers the choice for the session — a NEW quiz opens in it from card 1", () => {
    const first = renderHook(() => useQuizFlip(1));
    act(() => first.result.current.cycle()); // → meaning
    first.unmount();

    const { result } = renderHook(() => useQuizFlip(1));
    expect(result.current.pending).toBe("meaning");
    expect(result.current.reversed).toBe(true); // applies immediately, no deferral
    expect(result.current.pendingChange).toBe(false);
  });

  it("reads the pre-random stored value ('1' = meaning-first)", () => {
    sessionStorage.setItem("dino.quiz.reversed", "1");
    const { result } = renderHook(() => useQuizFlip(1));
    expect(result.current.pending).toBe("meaning");
  });
});
