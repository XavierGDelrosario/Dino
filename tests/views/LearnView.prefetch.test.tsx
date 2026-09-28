// @vitest-environment jsdom
// The level quiz's NEXT batch is drawn while the current one is being quizzed, so "New
// quiz" opens without a wait. Pinned: the prefetch over-fetches and never repeats a word
// from the batch in progress, "New quiz" swaps it in with no second fetch, and the quiz
// remounts for it (a same-size batch would otherwise leave the old "done" state up).
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { LocaleProvider } from "@/i18n";
import { makeWord } from "@test/fixtures";
import type { Word } from "@/services/words/repository";

vi.mock("@/services/session", () => ({
  getUserProfile: vi.fn(async () => ({ learningLanguage: "JA", nativeLanguage: "EN" })),
  updateUserLanguages: vi.fn(async () => {}),
}));
vi.mock("@/services/lists", () => ({
  listUserLists: vi.fn(async () => []),
  createList: vi.fn(async () => ({ listId: "l1", listName: "x" })),
}));
vi.mock("@/services/calibration", () => ({
  getUserProficiencyBand: vi.fn(async () => null),
  getUserLevel: vi.fn(async () => null),
  seedStability: vi.fn(() => null),
}));
vi.mock("@/views/MediaView", () => ({ MediaView: () => <div /> }));
vi.mock("@/services/proficiency", () => ({
  proficiencyFrameworkFor: () => ({ id: "jlpt", bands: [{ value: 3, label: "N3" }] }),
  labelForBand: () => "N3",
}));

const card = (input: string): Word[] => [makeWord({ wordId: `w-${input}`, input })];
const words = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => card(`${prefix}${i}`));

const fetchLearnWords = vi.fn();
vi.mock("@/services/learn", async () => {
  // The real nextLearnBatch (pure); only the network call is stubbed.
  const LEARN_BATCH = 10;
  return {
    LEARN_BATCH,
    fetchLearnWords: (p: unknown) => fetchLearnWords(p),
    nextLearnBatch: (current: Word[][], fetched: Word[][], size = LEARN_BATCH) => {
      const seen = new Set(current.map((c) => c[0]?.input));
      return fetched.filter((c) => !seen.has(c[0].input)).slice(0, size);
    },
  };
});

// A stand-in quiz: shows the batch and exposes "New quiz". Counts mounts, so the test
// can see the quiz remount for the next batch.
let mounts = 0;
vi.mock("@/views/TextQuizView", async () => {
  const { useEffect } = await import("react");
  return {
    TextQuizView: ({ cards, onNewQuiz }: { cards: Word[][]; onNewQuiz?: () => void }) => {
      useEffect(() => {
        mounts += 1;
      }, []);
      return (
        <div>
          <p data-testid="batch">{cards.map((c) => c[0].input).join(",")}</p>
          <button onClick={onNewQuiz}>next quiz</button>
        </div>
      );
    },
  };
});

import { LearnView } from "@/views/LearnView";

afterEach(() => {
  cleanup();
  fetchLearnWords.mockReset();
  mounts = 0;
});

describe("LearnView — prefetching the next level quiz", () => {
  it("draws the next batch during the quiz and swaps it in on New quiz, with no repeats", async () => {
    const first = words("a", 10);
    // The prefetch over-fetches; half of it overlaps the batch still being quizzed.
    const prefetch = [...words("a", 5), ...words("b", 15)];
    fetchLearnWords
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(prefetch)
      .mockResolvedValue(words("c", 20));

    render(
      <LocaleProvider>
        <LearnView userId="u" />
      </LocaleProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "N3" }));

    await waitFor(() => expect(screen.getByTestId("batch").textContent).toBe(first.map((c) => c[0].input).join(",")));
    // The next batch is already being drawn, asking for twice a batch to cover overlap.
    await waitFor(() => expect(fetchLearnWords).toHaveBeenCalledTimes(2));
    expect(fetchLearnWords.mock.calls[1][0]).toMatchObject({ band: 3, limit: 20 });

    fireEvent.click(screen.getByRole("button", { name: "next quiz" }));
    // Swapped in from the prefetch: none of the first batch's words, exactly ten.
    await waitFor(() => expect(screen.getByTestId("batch").textContent).toBe(words("b", 10).map((c) => c[0].input).join(",")));
    expect(mounts).toBe(2); // a fresh quiz for the new batch
    // …and the one after that is already on its way.
    await waitFor(() => expect(fetchLearnWords).toHaveBeenCalledTimes(3));
  });

  it("falls back to a normal fetch when the prefetch failed", async () => {
    fetchLearnWords
      .mockResolvedValueOnce(words("a", 10))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(words("d", 10))
      .mockResolvedValue([]);

    render(
      <LocaleProvider>
        <LearnView userId="u" />
      </LocaleProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "N3" }));
    await screen.findByTestId("batch");
    await waitFor(() => expect(fetchLearnWords).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByRole("button", { name: "next quiz" }));
    await waitFor(() => expect(screen.getByTestId("batch").textContent).toBe(words("d", 10).map((c) => c[0].input).join(",")));
    expect(fetchLearnWords.mock.calls[2][0]).toMatchObject({ band: 3, limit: 10 });
  });
});
