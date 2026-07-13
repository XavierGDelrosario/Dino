// @vitest-environment jsdom
// Hook spec for useQuizFlip — the quiz direction toggle. The contract that matters:
// a toggle NEVER changes the card in front of the user (it lands on the next card),
// and the choice is remembered for the session (so the next quiz opens in it).
import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useQuizFlip } from "@/hooks/useQuizFlip";

beforeEach(() => {
  sessionStorage.clear();
});

describe("useQuizFlip", () => {
  it("defaults to word-first", () => {
    const { result } = renderHook(() => useQuizFlip(1));
    expect(result.current.reversed).toBe(false);
    expect(result.current.pendingChange).toBe(false);
  });

  it("a toggle does NOT change the current card — only arms the next one", () => {
    const { result, rerender } = renderHook(({ pos }) => useQuizFlip(pos), {
      initialProps: { pos: 1 },
    });

    act(() => result.current.toggle());

    // Still showing the card the user is mid-recall on.
    expect(result.current.reversed).toBe(false);
    // ...but the button reflects the choice + the "next card" hint.
    expect(result.current.pending).toBe(true);
    expect(result.current.pendingChange).toBe(true);

    rerender({ pos: 2 }); // advance
    expect(result.current.reversed).toBe(true);
    expect(result.current.pendingChange).toBe(false);
  });

  it("toggling twice within one card is a no-op (back to the shown direction)", () => {
    const { result, rerender } = renderHook(({ pos }) => useQuizFlip(pos), {
      initialProps: { pos: 1 },
    });

    act(() => result.current.toggle());
    act(() => result.current.toggle());
    expect(result.current.pendingChange).toBe(false);

    rerender({ pos: 2 });
    expect(result.current.reversed).toBe(false);
  });

  it("the setting sticks across cards once applied", () => {
    const { result, rerender } = renderHook(({ pos }) => useQuizFlip(pos), {
      initialProps: { pos: 1 },
    });

    act(() => result.current.toggle());
    rerender({ pos: 2 });
    rerender({ pos: 3 });
    expect(result.current.reversed).toBe(true);
  });

  it("remembers the choice for the session — a NEW quiz opens reversed from card 1", () => {
    const first = renderHook(() => useQuizFlip(1));
    act(() => first.result.current.toggle());
    first.unmount();

    // Fresh mount = a new quiz session in the same app run.
    const { result } = renderHook(() => useQuizFlip(1));
    expect(result.current.reversed).toBe(true); // applies immediately, no deferral
    expect(result.current.pendingChange).toBe(false);
  });
});
