// @vitest-environment jsdom
// Swipe-to-cycle gesture on the flashcard: a horizontal drag past the threshold
// fires onSwipeLeft (next) / onSwipeRight (prev); taps and vertical scrolls don't.
// Plus the `reversed` display swap (meaning on the front), whose key property is
// that the reading never leaks onto the front face — it would spell out the answer.
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { LocaleProvider } from "@/i18n";
import { FlashcardCard } from "@/components/flashcards/FlashcardCard";

const face = {
  input: "辛い",
  translation: "spicy",
  inputReading: "からい",
  translationReading: null,
  sourceLang: "JA" as const,
  proficiencyBand: null,
  partOfSpeech: null,
  frequency: null,
};

function renderCard(props: { onSwipeLeft?: () => void; onSwipeRight?: () => void }) {
  const { container } = render(
    <LocaleProvider>
      <FlashcardCard word={face} flipped onFlip={() => {}} {...props} />
    </LocaleProvider>,
  );
  return container.querySelector(".flashcard") as HTMLElement;
}

// Drag from (200,100) by (dx,dy).
function swipe(el: HTMLElement, dx: number, dy = 0) {
  fireEvent.touchStart(el, { touches: [{ clientX: 200, clientY: 100 }] });
  fireEvent.touchEnd(el, { changedTouches: [{ clientX: 200 + dx, clientY: 100 + dy }] });
}

describe("FlashcardCard — swipe to cycle", () => {
  it("swipe left → onSwipeLeft (next)", () => {
    const left = vi.fn(), right = vi.fn();
    swipe(renderCard({ onSwipeLeft: left, onSwipeRight: right }), -80);
    expect(left).toHaveBeenCalledTimes(1);
    expect(right).not.toHaveBeenCalled();
  });

  it("swipe right → onSwipeRight (prev)", () => {
    const left = vi.fn(), right = vi.fn();
    swipe(renderCard({ onSwipeLeft: left, onSwipeRight: right }), 80);
    expect(right).toHaveBeenCalledTimes(1);
    expect(left).not.toHaveBeenCalled();
  });

  it("ignores a small horizontal move (tap, below threshold)", () => {
    const left = vi.fn(), right = vi.fn();
    swipe(renderCard({ onSwipeLeft: left, onSwipeRight: right }), -20);
    expect(left).not.toHaveBeenCalled();
    expect(right).not.toHaveBeenCalled();
  });

  it("ignores a vertical swipe (|dx| ≤ |dy|)", () => {
    const left = vi.fn(), right = vi.fn();
    swipe(renderCard({ onSwipeLeft: left, onSwipeRight: right }), -60, -120);
    expect(left).not.toHaveBeenCalled();
    expect(right).not.toHaveBeenCalled();
  });

  it("attaches no touch handling when no swipe callbacks are given", () => {
    // Sanity: the shared card (e.g. review surface) is unaffected — no throw on touch.
    const card = renderCard({});
    expect(() => swipe(card, -80)).not.toThrow();
  });
});

describe("FlashcardCard — reversed (meaning first)", () => {
  const view = (props: { flipped: boolean; reversed?: boolean }) =>
    render(
      <LocaleProvider>
        <FlashcardCard word={face} onFlip={() => {}} {...props} />
      </LocaleProvider>,
    ).container;

  it("front shows the meaning, not the term", () => {
    const c = view({ flipped: false, reversed: true });
    expect(c.querySelector(".flashcard__term")?.textContent).toBe("spicy");
    expect(c.textContent).not.toContain("辛い");
  });

  it("the reading stays on the REVEALED face (never spoils the front)", () => {
    // Unflipped: からい would give away 辛い, so it must not render.
    const front = view({ flipped: false, reversed: true });
    expect(front.querySelector(".flashcard__reading")).toBeNull();

    // Flipped: term + its reading appear together on the back.
    const back = view({ flipped: true, reversed: true });
    expect(back.querySelector(".flashcard__reading")?.textContent).toBe("からい");
    expect(back.querySelector(".flashcard__translation")?.textContent).toBe("辛い");
  });

  it("default direction is unchanged (term front, meaning + reading revealed)", () => {
    const c = view({ flipped: true });
    expect(c.querySelector(".flashcard__term")?.textContent).toBe("辛い");
    expect(c.querySelector(".flashcard__translation")?.textContent).toBe("spicy");
    expect(c.querySelector(".flashcard__reading")?.textContent).toBe("からい");
  });
});
