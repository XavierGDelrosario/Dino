// @vitest-environment jsdom
// The calibration swipe MOTION (useSwipeCard). The properties that matter are about
// timing and intent, not pixels: the rating commits only AFTER the card has flown
// out (so the next word never renders under a departing card), a short drag springs
// back without rating, a vertical drag is a page scroll, the click that ends a drag
// must not flip the card, and one card can only ever be rated once however the
// rating was triggered (drag, button, key).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, act, cleanup } from "@testing-library/react";
import { useSwipeCard } from "@/components/flashcards/useSwipeCard";

function Harness({
  onLeft,
  onRight,
  onFlip,
  onUp,
}: {
  onLeft: () => void;
  onRight: () => void;
  onFlip: () => void;
  onUp?: () => void;
}) {
  const { props, fling } = useSwipeCard({ onLeft, onRight, onUp });
  return (
    <div>
      <div data-testid="stage" {...props}>
        <div data-testid="card" onClick={onFlip}>辛い</div>
      </div>
      <button data-testid="left" onClick={() => fling("left")}>L</button>
      <button data-testid="right" onClick={() => fling("right")}>R</button>
    </div>
  );
}

function setup({ withUp = false } = {}) {
  const onLeft = vi.fn(), onRight = vi.fn(), onFlip = vi.fn(), onUp = vi.fn();
  // Query inside THIS render's container — the suite has no global auto-cleanup.
  const { container } = render(
    <Harness onLeft={onLeft} onRight={onRight} onFlip={onFlip} onUp={withUp ? onUp : undefined} />,
  );
  return {
    onLeft,
    onRight,
    onFlip,
    onUp,
    get: (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement,
  };
}

// jsdom implements no PointerEvent, so fireEvent.pointerDown(…) synthesizes a bare
// Event and DROPS clientX/clientY — a drag built that way moves zero pixels and every
// assertion passes vacuously. A MouseEvent under the pointer event's name carries the
// coordinates React reads, which is what actually exercises the gesture.
function pointer(el: HTMLElement, type: string, x: number, y: number) {
  fireEvent(el, new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y }));
}

/** Press, move in steps (so the slop/direction gate sees real motion), release. */
function drag(el: HTMLElement, dx: number, dy = 0) {
  pointer(el, "pointerdown", 200, 100);
  pointer(el, "pointermove", 200 + dx / 2, 100 + dy / 2);
  pointer(el, "pointermove", 200 + dx, 100 + dy);
  pointer(el, "pointerup", 200 + dx, 100 + dy);
}

describe("useSwipeCard", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("a drag past the commit distance flies out first, then rates", () => {
    const { onLeft, get } = setup();
    drag(get("stage"), -90);
    // Still on screen and un-rated: the card is mid-flight.
    expect(onLeft).not.toHaveBeenCalled();
    expect(get("stage").style.transform).toContain("translateX(-140%)");

    act(() => void vi.advanceTimersByTime(300));
    expect(onLeft).toHaveBeenCalledTimes(1);
    // …and it is back at rest for the incoming card (no leftover transform).
    expect(get("stage").style.transform).toBe("");
  });

  it("rates right for a rightward drag", () => {
    const { onLeft, onRight, get } = setup();
    drag(get("stage"), 90);
    act(() => void vi.advanceTimersByTime(300));
    expect(onRight).toHaveBeenCalledTimes(1);
    expect(onLeft).not.toHaveBeenCalled();
  });

  it("a short drag springs back without rating", () => {
    const { onLeft, onRight, get } = setup();
    drag(get("stage"), -30);
    act(() => void vi.advanceTimersByTime(300));
    expect(onLeft).not.toHaveBeenCalled();
    expect(onRight).not.toHaveBeenCalled();
    expect(get("stage").style.transform).toBe("");
  });

  it("without onUp, a vertical drag is ignored — the card neither moves nor rates", () => {
    const { onLeft, onRight, get } = setup();
    drag(get("stage"), -90, 120);
    act(() => void vi.advanceTimersByTime(300));
    expect(get("stage").style.transform).toBe("");
    expect(onLeft).not.toHaveBeenCalled();
    expect(onRight).not.toHaveBeenCalled();
  });

  describe("swipe UP (onUp)", () => {
    it("reveals on an up-swipe past the commit distance, without rating or flying out", () => {
      const { onUp, onLeft, onRight, get } = setup({ withUp: true });
      pointer(get("stage"), "pointerdown", 200, 200);
      pointer(get("stage"), "pointermove", 200, 150);
      // The card lifts with the finger, capped — it is not leaving.
      expect(get("stage").style.transform).toMatch(/translateY\(-\d+px\)/);
      pointer(get("stage"), "pointermove", 200, 100);
      pointer(get("stage"), "pointerup", 200, 100);

      expect(onUp).toHaveBeenCalledTimes(1);
      act(() => void vi.advanceTimersByTime(300));
      expect(onLeft).not.toHaveBeenCalled();
      expect(onRight).not.toHaveBeenCalled();
      expect(get("stage").style.transform).toBe(""); // settled back
    });

    it("a short up-drag or a DOWN-drag reveals nothing", () => {
      const { onUp, get } = setup({ withUp: true });
      drag(get("stage"), 0, -30);
      drag(get("stage"), 0, 120);
      expect(onUp).not.toHaveBeenCalled();
    });

    it("stays vertical once claimed: drifting sideways never turns it into a rating", () => {
      const { onUp, onLeft, onRight, get } = setup({ withUp: true });
      pointer(get("stage"), "pointerdown", 200, 200);
      pointer(get("stage"), "pointermove", 205, 170); // claimed as vertical
      pointer(get("stage"), "pointermove", 110, 120); // then wanders 90px left
      pointer(get("stage"), "pointerup", 110, 120);
      act(() => void vi.advanceTimersByTime(300));
      expect(onUp).toHaveBeenCalledTimes(1);
      expect(onLeft).not.toHaveBeenCalled();
      expect(onRight).not.toHaveBeenCalled();
    });

    it("the click ending an up-swipe does not also flip the card", () => {
      const { onFlip, get } = setup({ withUp: true });
      drag(get("stage"), 0, -90);
      fireEvent.click(get("card"));
      expect(onFlip).not.toHaveBeenCalled();
    });
  });

  it("the click ending a drag does not flip the card, but a plain tap does", () => {
    const { onFlip, get } = setup();
    drag(get("stage"), -90);
    fireEvent.click(get("card"));
    expect(onFlip).not.toHaveBeenCalled();

    act(() => void vi.advanceTimersByTime(300));
    fireEvent.click(get("card"));
    expect(onFlip).toHaveBeenCalledTimes(1);
  });

  it("fling() animates the button/keyboard path the same way", () => {
    const { onLeft, get } = setup();
    fireEvent.click(get("left"));
    expect(onLeft).not.toHaveBeenCalled();
    expect(get("stage").style.transform).toContain("translateX(-140%)");
    act(() => void vi.advanceTimersByTime(300));
    expect(onLeft).toHaveBeenCalledTimes(1);
  });

  it("a card can only be rated once — input during the fly-out is ignored", () => {
    const { onLeft, onRight, get } = setup();
    fireEvent.click(get("left"));
    fireEvent.click(get("right"));   // mashing the other button mid-flight
    drag(get("stage"), 90);          // …and dragging it too
    act(() => void vi.advanceTimersByTime(300));
    expect(onLeft).toHaveBeenCalledTimes(1);
    expect(onRight).not.toHaveBeenCalled();
  });
});
