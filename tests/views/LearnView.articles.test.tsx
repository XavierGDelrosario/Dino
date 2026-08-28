// @vitest-environment jsdom
// Articles (Wikinews) after the Media tab was retired into Learn.
//
// Two things are pinned, and they are the two ways this merge could quietly delete a
// feature rather than move it:
//   1. Learn OFFERS the way in, and the way back returns to Learn — a sub-surface with
//      no exit is a dead end you can only escape by switching tabs.
//   2. It survives the no-framework branch. Learn renders nothing but a message for a
//      language with no proficiency scale ingested, and Articles must NOT be behind
//      that gate: browsing news needs no JLPT bands, and gating it would have removed
//      the surface for exactly the learners it still works for.
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

// The real thing pulls Wikinews + the whole article analysis; this spec is about the
// NAVIGATION into and out of it, so a stub keeps the test honest about what it covers.
vi.mock("@/views/MediaView", () => ({
  MediaView: ({ onBack }: { onBack?: () => void }) => (
    <div>
      <p>ARTICLES SURFACE</p>
      {onBack && <button onClick={onBack}>← Learn</button>}
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

const articlesBtn = () => screen.getByRole("button", { name: /Articles/ });

beforeEach(() => {
  framework.mockReturnValue({ id: "jlpt", bands: [{ value: 5, label: "N5" }] } as unknown);
});
afterEach(cleanup);

describe("LearnView — Articles", () => {
  it("opens the articles surface and comes back to Learn", async () => {
    view();
    // The band picker is Learn's own content; it proves we start on Learn, not Media.
    expect(await screen.findByRole("button", { name: "N5" })).toBeTruthy();

    fireEvent.click(articlesBtn());
    expect(await screen.findByText("ARTICLES SURFACE")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "N5" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /← Learn/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "N5" })).toBeTruthy());
    expect(screen.queryByText("ARTICLES SURFACE")).toBeNull();
  });

  it("stays reachable for a language with no proficiency framework", async () => {
    framework.mockReturnValue(null as unknown);
    view();

    // Learn itself has nothing to offer here — but Articles still does.
    fireEvent.click(articlesBtn());
    expect(await screen.findByText("ARTICLES SURFACE")).toBeTruthy();
  });
});
