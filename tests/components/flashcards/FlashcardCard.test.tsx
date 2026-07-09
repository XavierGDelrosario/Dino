// @vitest-environment jsdom
// Swipe-to-cycle gesture on the flashcard: a horizontal drag past the threshold
// fires onSwipeLeft (next) / onSwipeRight (prev); taps and vertical scrolls don't.
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
