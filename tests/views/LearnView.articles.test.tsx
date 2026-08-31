// @vitest-environment jsdom
// Articles (Wikinews) after the Media tab was retired into Learn — and then, once it
// was no longer a tab, out of its "📰 Articles" button and INTO the Learn tab itself,
// as a section under the level bands.
//
// Three things are pinned, and they are the ways this merge could quietly delete a
// feature rather than move it:
//   1. The browse is IN the tab, below the bands — not behind a button, and not
//      instead of them: both ways into new words are on screen at once.
//   2. It survives the no-framework branch. Learn has nothing but a message for a
//      language with no proficiency scale ingested, and Articles must NOT be behind
//      that gate: browsing news needs no JLPT bands, and gating it would have removed
//      the surface for exactly the learners it still works for.
//   3. The article ANALYSIS still gets the tab to itself. It renders in the embedded
//      view's own slot, so Learn folds its chrome away while one is open — otherwise a
//      language picker and a row of level buttons sit on top of a page of prose.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { LocaleProvider } from "@/i18n";

const getUserProfile = vi.fn(async (_userId: string) => ({
  learningLanguage: "JA" as string | null,
  nativeLanguage: "EN" as string | null,
}));
vi.mock("@/services/session", () => ({
  getUserProfile: (userId: string) => getUserProfile(userId),
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

vi.mock("@/services/learn", () => ({ fetchLearnWords: vi.fn(async () => []) }));

// The real thing pulls Wikinews + the whole article analysis; this spec is about how
// Learn HOSTS it, so a stub keeps the test honest about what it covers. It reports the
// open/close the same way the real one does (an effect on the open article), which is
// the signal Learn folds its chrome on.
vi.mock("@/views/MediaView", () => ({
  MediaView: ({
    langs,
    ready,
    onArticleOpen,
  }: {
    langs: { learning: string; native: string };
    ready: boolean;
    onArticleOpen?: (open: boolean) => void;
  }) => (
    <div>
      <p>ARTICLES SURFACE</p>
      <p>{`pair:${langs.learning}->${langs.native} ready:${ready}`}</p>
      <button onClick={() => onArticleOpen?.(true)}>open article</button>
      <button onClick={() => onArticleOpen?.(false)}>close article</button>
    </div>
  ),
}));

// Swapped per-test to exercise the no-framework branch.
const framework = vi.fn(() => ({
  id: "jlpt",
  bands: [{ value: 5, label: "N5" }],
}) as unknown);
vi.mock("@/services/proficiency", () => ({
  proficiencyFrameworkFor: () => framework(),
  labelForBand: () => "N5",
}));

import { LearnView } from "@/views/LearnView";

const view = () =>
  render(
    <LocaleProvider>
      <LearnView userId="u" />
    </LocaleProvider>,
  );

beforeEach(() => {
  framework.mockReturnValue({ id: "jlpt", bands: [{ value: 5, label: "N5" }] } as unknown);
});
afterEach(cleanup);

describe("LearnView — Articles", () => {
  it("renders the browse in the tab, under the level bands", async () => {
    view();
    // Both ways into new words, on screen together — no button, no navigation.
    expect(await screen.findByRole("button", { name: "N5" })).toBeTruthy();
    expect(await screen.findByText("ARTICLES SURFACE")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /📰 Articles/ })).toBeNull();

    // Order matters: it is the SECOND section, not a header above the bands.
    const bands = screen.getByRole("button", { name: "N5" });
    const articles = screen.getByText("ARTICLES SURFACE");
    expect(bands.compareDocumentPosition(articles) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("hands the browse the tab's own pair, once the profile has settled", async () => {
    view();
    // The picker here is the only one — the embedded view has none of its own, so a
    // wrong pair would silently browse the wrong wiki with nothing to correct it.
    expect(await screen.findByText("pair:JA->EN ready:true")).toBeTruthy();
  });

  it("stays on screen for a language with no proficiency framework", async () => {
    framework.mockReturnValue(null as unknown);
    view();

    // Learn itself has nothing to offer here — but Articles still does.
    expect(await screen.findByText("ARTICLES SURFACE")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "N5" })).toBeNull();
  });

  it("folds Learn's chrome away while an article analysis is open", async () => {
    view();
    expect(await screen.findByRole("button", { name: "N5" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "open article" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "N5" })).toBeNull());
    // The browse itself is never unmounted — remounting it would lose the open article.
    expect(screen.getByText("ARTICLES SURFACE")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "close article" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "N5" })).toBeTruthy());
  });
});
