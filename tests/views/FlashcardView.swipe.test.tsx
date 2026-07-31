// @vitest-environment jsdom
// Swipe-to-grade on a FACE-DOWN review card: right = 5 (knew it), left = 1 (forgot).
// The rule that matters is the gate — a revealed card must NOT be swipe-gradable,
// because the 1–5 bar is showing and a stray drag would silently record a 5 for
// someone reaching for a 3.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, act, cleanup } from "@testing-library/react";
import { LocaleProvider } from "@/i18n";

const grade = vi.fn();
const flipCard = vi.fn();
const state = {
  status: "active" as string,
  flipped: false,
  submitting: false,
  position: 1,
  total: 3,
  reviewedCount: 0,
  error: null as string | null,
  current: {
    userWordId: "uw-1",
    input: "猫",
    translation: "cat",
    inputReading: "ねこ",
    translationReading: null,
    sourceLang: "JA",
    proficiencyBand: null,
    partOfSpeech: null,
    frequency: null,
  },
  grade,
  flip: flipCard,
  restart: vi.fn(),
  retry: vi.fn(),
  newQuiz: vi.fn(),
};

vi.mock("@/hooks/useReview", () => ({ useReview: () => state }));
// The card renders a WordInfo panel that reads difficulty/proficiency services;
// none of that is under test here.
vi.mock("@/services/voice", () => ({
  isVoiceAvailable: () => Promise.resolve(false),
  speak: vi.fn(),
  cancelSpeech: vi.fn(),
  pronounceableText: (w: { input: string }) => w.input,
}));

import { FlashcardView } from "@/views/FlashcardView";

function renderView() {
  const { container } = render(
    <LocaleProvider>
      <FlashcardView userId="u1" />
    </LocaleProvider>,
  );
  return container;
}

/** jsdom has no PointerEvent — a MouseEvent under the pointer name carries clientX. */
function pointer(el: Element, type: string, x: number, y: number) {
  fireEvent(el, new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y }));
}

function swipe(el: Element, dx: number) {
  pointer(el, "pointerdown", 200, 100);
  pointer(el, "pointermove", 200 + dx / 2, 100);
  pointer(el, "pointermove", 200 + dx, 100);
  pointer(el, "pointerup", 200 + dx, 100);
  act(() => void vi.advanceTimersByTime(300)); // let the fly-out finish
}

describe("FlashcardView — swipe to grade", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    state.flipped = false;
    state.submitting = false;
    grade.mockClear();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("swiping right on a face-down card grades 5", () => {
    const stage = renderView().querySelector(".swipecard")!;
    swipe(stage, 90);
    expect(grade).toHaveBeenCalledWith(5);
  });

  it("swiping left on a face-down card grades 1", () => {
    const stage = renderView().querySelector(".swipecard")!;
    swipe(stage, -90);
    expect(grade).toHaveBeenCalledWith(1);
  });

  it("a REVEALED card is not swipe-gradable — the 1–5 bar owns the decision", () => {
    state.flipped = true;
    const container = renderView();
    // No swipe stage is wired at all once the card is face-up.
    expect(container.querySelector(".swipecard")).toBeNull();
  });

  it("does not grade again while a grade is already submitting", () => {
    state.submitting = true;
    const container = renderView();
    expect(container.querySelector(".swipecard")).toBeNull();
  });
});
