// @vitest-environment jsdom
// The flashcard quiz's done screen lists the words the session showed, BELOW the
// Retry / New quiz buttons — on BOTH flashcard components (FlashcardView and
// TextQuizView), since a change to "the flashcard quiz" applies to every surface.
// The hooks are mocked — this is view wiring, not the quiz loop.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { LocaleProvider } from "@/i18n";
import { makeWord } from "@test/fixtures";

const neko = makeWord({ wordId: "neko", input: "猫", translation: "cat", inputReading: "ねこ" });
const inu = makeWord({ wordId: "inu", input: "犬", translation: "dog", inputReading: "いぬ" });

vi.mock("@/hooks/useTextQuiz", () => ({
  useTextQuiz: () => ({
    status: "done",
    current: null,
    senses: [],
    gradedWords: [neko, inu],
    reviewedCount: 2,
    addedCount: 2,
    position: 3,
    total: 2,
    restart: vi.fn(),
  }),
}));
vi.mock("@/hooks/useReview", () => ({
  useReview: () => ({
    status: "done",
    current: null,
    cards: [
      { ...neko, userWordId: "uw-neko" },
      { ...inu, userWordId: "uw-inu" },
    ],
    reviewedCount: 2,
    position: 3,
    total: 2,
    grade: vi.fn(),
    retry: vi.fn(),
    newQuiz: vi.fn(),
    restart: vi.fn(),
  }),
}));

const { TextQuizView } = await import("@/views/TextQuizView");
const { FlashcardView } = await import("@/views/FlashcardView");

afterEach(cleanup);

/** Every listed word is present, and the list comes after the named button. */
function expectListBelow(container: HTMLElement, buttonName: RegExp) {
  const rows = [...container.querySelectorAll(".quizwords__row")].map((r) => r.textContent);
  expect(rows).toEqual(["猫ねこcat", "犬いぬdog"]);
  const button = screen.getByRole("button", { name: buttonName });
  const list = container.querySelector(".quizwords")!;
  expect(button.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
}

describe("flashcard quiz done screen — word recap", () => {
  it("TextQuizView lists the quizzed words below Quiz again / New quiz", () => {
    const { container } = render(
      <LocaleProvider>
        <TextQuizView
          userId="u1"
          cards={[[neko], [inu]]}
          lists={[]}
          onCreateList={vi.fn()}
          onClose={vi.fn()}
          onNewQuiz={vi.fn()}
        />
      </LocaleProvider>,
    );
    expectListBelow(container, /New quiz/);
  });

  it("FlashcardView lists the reviewed words below Retry / New quiz", () => {
    const { container } = render(
      <LocaleProvider>
        <FlashcardView userId="u1" />
      </LocaleProvider>,
    );
    expectListBelow(container, /New quiz/);
    expect(screen.queryByText(/🎉/)).toBeNull();
  });
});
