// @vitest-environment jsdom
// The flashcard quiz's done screen: no summary line and no title, just the words the
// session showed BELOW the Retry / New quiz buttons, drawn as Lists rows — reading in
// its own element, meanings one per line (never the raw "a; b" run), live confidence
// dots that ARE the Forgot control, the ＋ add-to-list menu, and the speak button. On BOTH flashcard components
// (FlashcardView and TextQuizView), since a change to "the flashcard quiz" applies to
// every surface. The hooks are mocked — this is view wiring, not the quiz loop.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { LocaleProvider } from "@/i18n";
import { makeWord } from "@test/fixtures";

const neko = makeWord({ wordId: "neko", input: "猫", translation: "cat; feline", inputReading: "ねこ" });
const inu = makeWord({ wordId: "inu", input: "犬", translation: "dog", inputReading: "いぬ" });

const soften = vi.fn();
vi.mock("@/services/review", async (orig) => ({
  ...(await orig<typeof import("@/services/review")>()),
  softenConfidence: (...a: unknown[]) => soften(...a),
}));
vi.mock("@/services/voice", () => ({
  isVoiceAvailable: () => Promise.resolve(false),
  speak: vi.fn(),
  cancelSpeech: vi.fn(),
  pronounceableText: (w: { input: string }) => w.input,
}));

const tag = vi.fn();
vi.mock("@/services/words/userWords", async (orig) => ({
  ...(await orig<typeof import("@/services/words/userWords")>()),
  addUserWordToList: (...a: unknown[]) => tag(...a),
}));
const listLists = vi.fn();
const makeList = vi.fn();
vi.mock("@/services/lists", async (orig) => ({
  ...(await orig<typeof import("@/services/lists")>()),
  listUserLists: (...a: unknown[]) => listLists(...a),
  createList: (...a: unknown[]) => makeList(...a),
}));

const onGraded = vi.fn();
const onCreateList = vi.fn();
const LISTS = [{ listId: "l-food", listName: "Food" }];
vi.mock("@/hooks/useTextQuiz", () => ({
  useTextQuiz: () => ({
    status: "done",
    current: null,
    senses: [],
    graded: [
      { word: neko, userWordId: "uw-neko", confidence: 4 },
      { word: inu, userWordId: "uw-inu", confidence: 1 },
    ],
    reviewedCount: 2,
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
      { ...neko, userWordId: "uw-neko", confidenceRating: 2 },
      { ...inu, userWordId: "uw-inu", confidenceRating: 1 },
    ],
    // Neko was graded up to 4 this session; the done screen shows THAT, not the 2 it
    // came in with.
    gradedConfidence: new Map([["uw-neko", 4]]),
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

beforeEach(() => {
  listLists.mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  soften.mockReset();
  onGraded.mockReset();
  tag.mockReset();
  listLists.mockReset();
  makeList.mockReset();
  onCreateList.mockReset();
});

function renderText() {
  return render(
    <LocaleProvider>
      <TextQuizView
        userId="u1"
        cards={[[neko], [inu]]}
        lists={LISTS}
        onCreateList={onCreateList}
        onClose={vi.fn()}
        onNewQuiz={vi.fn()}
        onGraded={onGraded}
      />
    </LocaleProvider>,
  );
}
function renderReview() {
  return render(
    <LocaleProvider>
      <FlashcardView userId="u1" />
    </LocaleProvider>,
  );
}

const rows = (c: HTMLElement) => [...c.querySelectorAll(".quizwords .listrow")] as HTMLElement[];

function expectListRows(container: HTMLElement) {
  const [first, second] = rows(container);
  expect(first.querySelector(".listrow__head")?.firstChild?.textContent).toBe("猫");
  expect(first.querySelector(".listrow__reading")?.textContent).toBe("ねこ");
  // Semicolons gone: one line per meaning.
  expect([...first.querySelectorAll(".listrow__meaning-line")].map((l) => l.textContent)).toEqual([
    "cat",
    "feline",
  ]);
  expect(first.textContent).not.toContain(";");
  expect(first.querySelector(".dots")).toBeTruthy();
  expect(second.querySelector(".listrow__reading")?.textContent).toBe("いぬ");

  // Below the actions, and no summary line or visible title.
  const button = screen.getByRole("button", { name: /New quiz/ });
  const list = container.querySelector(".quizwords")!;
  expect(button.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.queryByText(/Done|Reviewed \d|Added \d|Words in this quiz/)).toBeNull();
}

describe("flashcard quiz done screen — word recap as Lists rows", () => {
  it("TextQuizView: Lists-style rows below Quiz again / New quiz", () => {
    expectListRows(renderText().container);
  });

  it("FlashcardView: Lists-style rows below Retry / New quiz, with the post-grade confidence", () => {
    const { container } = renderReview();
    expectListRows(container);
    expect(rows(container)[0].querySelector(".dots")?.getAttribute("aria-label")).toMatch(/4/);
  });

  it("the dots are the Forgot control: a saved word drops a notch and the reader is told", async () => {
    soften.mockResolvedValue({ userWordId: "uw-neko", confidenceRating: 3, stability: 5, lastReviewedDate: "" });
    const { container } = renderText();
    const first = rows(container)[0];

    fireEvent.click(first.querySelector("button[aria-label*='orgot']")!);
    fireEvent.click(screen.getByRole("button", { name: /^Forgot\?$/ }));

    await waitFor(() => expect(soften).toHaveBeenCalledWith({ userWordId: "uw-neko" }));
    await waitFor(() => expect(onGraded).toHaveBeenCalledWith("neko", "uw-neko", 3));
    // The dots carry their number in their accessible name, not as text.
    await waitFor(() =>
      expect(first.querySelector("button[aria-label*='orgot']")?.getAttribute("aria-label")).toMatch(/\b3\b/),
    );
  });

  it("＋ files a word into an existing list (text quiz)", async () => {
    tag.mockResolvedValue(undefined);
    const { container } = renderText();
    const first = rows(container)[0];
    fireEvent.click(first.querySelector("button[aria-label='Add to a list']")!);
    fireEvent.click(screen.getByRole("button", { name: "Food" }));
    await waitFor(() => expect(tag).toHaveBeenCalledWith({ userWordId: "uw-neko", listId: "l-food" }));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull()); // the menu closes
  });

  it("＋ → New list creates it through the caller, then files the word into it", async () => {
    tag.mockResolvedValue(undefined);
    onCreateList.mockResolvedValue("l-new");
    const { container } = renderText();
    fireEvent.click(rows(container)[1].querySelector("button[aria-label='Add to a list']")!);
    fireEvent.click(screen.getByRole("button", { name: /New list/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "New list name" }), { target: { value: "Animals" } });
    fireEvent.click(screen.getByTitle("Create"));
    await waitFor(() => expect(onCreateList).toHaveBeenCalledWith("Animals"));
    await waitFor(() => expect(tag).toHaveBeenCalledWith({ userWordId: "uw-inu", listId: "l-new" }));
  });

  it("Review loads the user's lists for the ＋ menu, and a new list joins it", async () => {
    listLists.mockResolvedValue(LISTS);
    makeList.mockResolvedValue({ listId: "l-new", listName: "Animals" });
    tag.mockResolvedValue(undefined);
    const { container } = renderReview();
    await waitFor(() => expect(listLists).toHaveBeenCalledWith("u1"));

    fireEvent.click(rows(container)[0].querySelector("button[aria-label='Add to a list']")!);
    expect(await screen.findByRole("button", { name: "Food" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /New list/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "New list name" }), { target: { value: "Animals" } });
    fireEvent.click(screen.getByTitle("Create"));
    await waitFor(() => expect(makeList).toHaveBeenCalledWith({ userId: "u1", listName: "Animals" }));
    await waitFor(() => expect(tag).toHaveBeenCalledWith({ userWordId: "uw-neko", listId: "l-new" }));
  });

  it("a word below the soften floor keeps plain dots (nothing to lower)", () => {
    const { container } = renderText();
    expect(rows(container)[1].querySelector("button[aria-label*='orgot']")).toBeNull();
  });
});
