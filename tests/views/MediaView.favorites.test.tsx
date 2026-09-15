// @vitest-environment jsdom
// Media tab ★ favourites — the wiring, not the services (both are mocked):
//   - each browse headline carries a star that reflects whether it's saved;
//   - starring calls the service and flips the star without a reload;
//   - the ★ Saved tab lists what's stored (and says so when nothing is), which is
//     the whole point: browse is RANDOM, so an unsaved story can't be found again.
// Plus the corpus itself: the tab reads the Wikinews edition of the LEARNING
// language (and scopes the ★ list to it), so the profile is mocked rather than
// left to a real fetch.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { LocaleProvider } from "@/i18n";

const headlines = [
  { title: "台風が九州に接近", summary: "気象庁によると…", url: "https://ja.wikinews.org/wiki/A" },
  { title: "新しい駅が開業", summary: "", url: "https://ja.wikinews.org/wiki/B" },
];

const favoriteRow = {
  favoriteId: "f1",
  title: "保存した記事",
  summary: "",
  url: "https://ja.wikinews.org/wiki/SAVED",
  site: "wikinews" as const,
  lang: "JA",
  createdAt: "2026-08-01T00:00:00Z",
};

type Headline = (typeof headlines)[number];

const listFavorites = vi.fn(
  async (_userId: string, _scope?: { site?: string; lang?: string }) => [favoriteRow],
);
const addFavorite = vi.fn(async (_p: { userId: string; headline: Headline }) => ({
  ...favoriteRow,
  favoriteId: "f2",
  url: headlines[0].url,
}));
const removeFavorite = vi.fn(async (_p: { userId: string; url: string }) => {});

const randomHeadlines = vi.fn(async (_p?: { site?: string; lang?: string; limit?: number }) =>
  headlines,
);

vi.mock("@/services/media/mediawiki", async (orig) => ({
  ...(await orig<typeof import("@/services/media/mediawiki")>()),
  randomHeadlines: (p?: { site?: string; lang?: string; limit?: number }) => randomHeadlines(p),
  fetchArticle: vi.fn(),
}));

vi.mock("@/services/media/favorites", () => ({
  listFavorites: (userId: string, scope?: { site?: string; lang?: string }) =>
    listFavorites(userId, scope),
  addFavorite: (p: { userId: string; headline: Headline }) => addFavorite(p),
  removeFavorite: (p: { userId: string; url: string }) => removeFavorite(p),
}));

// The learning language decides which wiki the tab reads, so the profile can't be
// left to a real (failing) fetch — that would only ever exercise the default.
const getUserProfile = vi.fn(async (_userId: string) => ({
  learningLanguage: "JA" as string | null,
  nativeLanguage: "EN" as string | null,
}));

const updateUserLanguages = vi.fn(async (_p: unknown) => {});

vi.mock("@/services/session", () => ({
  getUserProfile: (userId: string) => getUserProfile(userId),
  updateUserLanguages: (p: unknown) => updateUserLanguages(p),
}));

import { MediaView } from "@/views/MediaView";

// The pair and the profile-settled flag are the HOST's now (Learn's picker), so the
// spec supplies them the way Learn does.
const view = (langs = { learning: "JA", native: "EN" }, ready = true) =>
  render(
    <LocaleProvider>
      <MediaView userId="u" langs={langs} ready={ready} />
    </LocaleProvider>,
  );

const stars = () => screen.getAllByRole("button", { name: /Save this article|Remove from saved/ });
const savedTab = () => screen.getByRole("tab", { name: /Saved/ });

beforeEach(() => {
  listFavorites.mockClear();
  addFavorite.mockClear();
  removeFavorite.mockClear();
  randomHeadlines.mockClear();
  getUserProfile.mockClear();
  updateUserLanguages.mockClear();
});
afterEach(cleanup);

describe("MediaView — ★ favourites", () => {
  it("draws an empty star on an unsaved headline and stars it on click", async () => {
    view();
    await screen.findByText("台風が九州に接近");
    const [first] = stars();
    expect(first.textContent).toBe("☆");

    fireEvent.click(first);
    await waitFor(() => expect(addFavorite).toHaveBeenCalledTimes(1));
    expect(addFavorite.mock.calls[0][0]).toMatchObject({
      userId: "u",
      headline: headlines[0],
    });
    // Optimistic: the star flips without re-reading the list from the server.
    expect(stars()[0].textContent).toBe("★");
    expect(listFavorites).toHaveBeenCalledTimes(1);
  });

  it("un-stars an already-saved article", async () => {
    listFavorites.mockResolvedValueOnce([{ ...favoriteRow, url: headlines[0].url }]);
    view();
    await waitFor(() => expect(stars()[0].textContent).toBe("★"));

    fireEvent.click(stars()[0]);
    await waitFor(() => expect(removeFavorite).toHaveBeenCalledTimes(1));
    expect(removeFavorite.mock.calls[0][0]).toMatchObject({ userId: "u", url: headlines[0].url });
    expect(stars()[0].textContent).toBe("☆");
  });

  it("the Saved tab lists the stored articles, not the random batch", async () => {
    view();
    await screen.findByText("台風が九州に接近");

    fireEvent.click(savedTab());
    expect(await screen.findByText("保存した記事")).toBeTruthy();
    expect(screen.queryByText("台風が九州に接近")).toBeNull();
  });

  it("browses the Wikinews edition of the language it is handed", async () => {
    view({ learning: "EN", native: "JA" });
    await screen.findByText("台風が九州に接近");

    // Both the browse fetch and the ★ list are scoped to that corpus — a JA-learner's
    // saved articles aren't studiable while learning English, and vice versa.
    expect(randomHeadlines).toHaveBeenCalledWith(
      expect.objectContaining({ site: "wikinews", lang: "EN" }),
    );
    expect(listFavorites).toHaveBeenCalledWith("u", { site: "wikinews", lang: "EN" });
    expect(randomHeadlines).toHaveBeenCalledTimes(1);
  });

  it("fetches nothing until the host says the profile has settled", async () => {
    // Otherwise the first paint browses the DEFAULT language's wiki and immediately
    // refetches the real one — a wasted round-trip and a visible flash of the wrong
    // corpus.
    const { rerender } = view({ learning: "JA", native: "EN" }, false);
    expect(randomHeadlines).not.toHaveBeenCalled();

    rerender(
      <LocaleProvider>
        <MediaView userId="u" langs={{ learning: "EN", native: "JA" }} ready />
      </LocaleProvider>,
    );
    await waitFor(() => expect(randomHeadlines).toHaveBeenCalledTimes(1));
    expect(randomHeadlines).toHaveBeenCalledWith(
      expect.objectContaining({ site: "wikinews", lang: "EN" }),
    );
  });

  it("follows the host's language, re-scoping the browse and the ★ list", async () => {
    // The picker lives in Learn now, so a switch arrives as a new prop rather than an
    // onChange — and everything keyed on the corpus has to move with it. Nothing here
    // may write the profile back: browsing another language's news for one session
    // must not rewrite the saved pair.
    const { rerender } = view();
    await screen.findByText("台風が九州に接近");

    rerender(
      <LocaleProvider>
        <MediaView userId="u" langs={{ learning: "EN", native: "JA" }} ready />
      </LocaleProvider>,
    );

    await waitFor(() =>
      expect(randomHeadlines).toHaveBeenLastCalledWith(
        expect.objectContaining({ site: "wikinews", lang: "EN" }),
      ),
    );
    expect(listFavorites).toHaveBeenLastCalledWith("u", { site: "wikinews", lang: "EN" });
    expect(updateUserLanguages).not.toHaveBeenCalled();
  });

  it("explains the empty Saved tab instead of showing a blank list", async () => {
    listFavorites.mockResolvedValueOnce([]);
    view();
    await screen.findByText("台風が九州に接近");

    fireEvent.click(savedTab());
    expect(await screen.findByText(/No saved articles yet/)).toBeTruthy();
  });
});
