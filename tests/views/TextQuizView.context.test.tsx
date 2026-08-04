// @vitest-environment jsdom
// The quiz's "Show in context" reveal. The word→sentence mapping itself is unit-tested
// in tests/services/analyze/context.test.ts; what's pinned HERE is the wiring:
//   - the button appears only when the card's word HAS source sentences;
//   - it stays collapsed until pressed (the card must remain a cold recall test);
//   - revealed, it shows the sentence with the occurrence highlighted;
//   - the sentence's TRANSLATION is withheld until the card itself is revealed,
//     since it would otherwise hand over the answer.
// useTextQuiz is mocked — this is view wiring, not the quiz loop.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { LocaleProvider } from "@/i18n";
import { makeWord } from "@test/fixtures";
import type { WordContext } from "@/services/analyze/context";

const neko = makeWord({ wordId: "neko", input: "猫", translation: "cat" });

let flipped = false;
vi.mock("@/hooks/useTextQuiz", () => ({
  useTextQuiz: () => ({
    status: "reviewing",
    current: neko,
    senses: [neko],
    meaningIndex: 0,
    hasMultipleMeanings: false,
    nextMeaning: vi.fn(),
    prevMeaning: vi.fn(),
    addWord: vi.fn(),
    isCurrentSaved: false,
    flipped,
    flip: vi.fn(),
    grade: vi.fn(),
    submitting: false,
    error: null,
    position: 1,
    total: 1,
    reviewedCount: 0,
    addedCount: 0,
    restart: vi.fn(),
  }),
}));

const { TextQuizView } = await import("@/views/TextQuizView");

const context = new Map<string, WordContext[]>([
  [
    "neko",
    [{ text: "猫が好きです。", gloss: "I like cats.", spans: [{ start: 0, end: 1 }] }],
  ],
]);

function renderQuiz(ctx?: Map<string, WordContext[]>) {
  return render(
    <LocaleProvider>
      <TextQuizView
        userId="u1"
        cards={[[neko]]}
        lists={[]}
        context={ctx}
        onCreateList={vi.fn()}
        onClose={vi.fn()}
      />
    </LocaleProvider>,
  );
}

afterEach(() => {
  cleanup();
  flipped = false;
});

describe("TextQuizView — show in context", () => {
  it("hides the sentence until the button is pressed", () => {
    renderQuiz(context);
    expect(screen.queryByText(/猫が好きです/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Show in context/ }));
    expect(screen.getByText(/好きです/)).toBeTruthy();
  });

  it("highlights the occurrence inside the sentence", () => {
    const { container } = renderQuiz(context);
    fireEvent.click(screen.getByRole("button", { name: /Show in context/ }));
    const hit = container.querySelector(".quizctx__hit");
    expect(hit?.textContent).toBe("猫");
  });

  it("withholds the sentence translation while the card is still unrevealed", () => {
    renderQuiz(context);
    fireEvent.click(screen.getByRole("button", { name: /Show in context/ }));
    expect(screen.queryByText("I like cats.")).toBeNull();
  });

  it("shows the sentence translation once the card is revealed", () => {
    flipped = true;
    renderQuiz(context);
    fireEvent.click(screen.getByRole("button", { name: /Show in context/ }));
    expect(screen.getByText("I like cats.")).toBeTruthy();
  });

  it("sits BELOW the card and above the grade bar", () => {
    const { container } = renderQuiz(context);
    const order = [...container.querySelectorAll(".quizcard, .quizctx, .gradebar")].map(
      (el) => el.className.split(" ")[0],
    );
    expect(order.indexOf("quizctx")).toBeGreaterThan(order.indexOf("quizcard"));
  });

  it("offers no button at all when the surface has no source text (the Learn quiz)", () => {
    renderQuiz(undefined);
    expect(screen.queryByRole("button", { name: /Show in context/ })).toBeNull();
  });
});
