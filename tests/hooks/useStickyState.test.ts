// @vitest-environment jsdom
// The two properties the tab-persistence behaviour rests on: a value survives an
// UNMOUNT (that's the whole point — the tab nav unmounts views), and it does NOT
// survive a user change (the views are keyed on userId so a sign-in/out resets
// them; the cache has to reset with them or the next user inherits the last one's
// input and filters).
import { describe, it, expect, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useStickyState, resetStickyState } from "@/hooks/useStickyState";

afterEach(() => {
  cleanup();
  resetStickyState();
});

const render = (userId: string) =>
  renderHook(() => useStickyState(userId, "translate.input", ""));

describe("useStickyState", () => {
  it("restores the value after an unmount (tab switch away and back)", () => {
    const first = render("user-1");
    act(() => first.result.current[1]("食べる"));
    first.unmount();

    expect(render("user-1").result.current[0]).toBe("食べる");
  });

  it("starts from the initial value for a DIFFERENT user", () => {
    const guest = render("guest-1");
    act(() => guest.result.current[1]("食べる"));
    guest.unmount();

    expect(render("user-2").result.current[0]).toBe("");
  });

  it("does not hand a user's value back after switching away and returning", () => {
    const guest = render("guest-1");
    act(() => guest.result.current[1]("食べる"));
    guest.unmount();

    render("user-2").unmount(); // switching users clears the cache...
    expect(render("guest-1").result.current[0]).toBe(""); // ...so guest-1 starts clean too
  });

  it("keeps separate keys independent", () => {
    const a = renderHook(() => useStickyState("user-1", "lists.query", ""));
    const b = renderHook(() => useStickyState("user-1", "lists.sort", "newest"));
    act(() => a.result.current[1]("ねこ"));

    expect(b.result.current[0]).toBe("newest");
    a.unmount();
    expect(renderHook(() => useStickyState("user-1", "lists.query", "")).result.current[0]).toBe("ねこ");
  });
});
