// @vitest-environment jsdom
// Media tab ★ favourites — the wiring, not the services (both are mocked):
//   - each browse headline carries a star that reflects whether it's saved;
//   - starring calls the service and flips the star without a reload;
//   - the ★ Saved tab lists what's stored (and says so when nothing is), which is
//     the whole point: browse is RANDOM, so an unsaved story can't be found again.
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

const listFavorites = vi.fn(async (_userId: string) => [favoriteRow]);
const addFavorite = vi.fn(async (_p: { userId: string; headline: Headline }) => ({
  ...favoriteRow,
  favoriteId: "f2",
  url: headlines[0].url,
}));
const removeFavorite = vi.fn(async (_p: { userId: string; url: string }) => {});

vi.mock("@/services/media/mediawiki", async (orig) => ({
  ...(await orig<typeof import("@/services/media/mediawiki")>()),
  randomHeadlines: vi.fn(async () => headlines),
  fetchArticle: vi.fn(),
}));

vi.mock("@/services/media/favorites", () => ({
  listFavorites: (userId: string) => listFavorites(userId),
  addFavorite: (p: { userId: string; headline: Headline }) => addFavorite(p),
  removeFavorite: (p: { userId: string; url: string }) => removeFavorite(p),
}));

import { MediaView } from "@/views/MediaView";

const view = () =>
  render(
    <LocaleProvider>
      <MediaView userId="u" />
    </LocaleProvider>,
  );

const stars = () => screen.getAllByRole("button", { name: /Save this article|Remove from saved/ });
const savedTab = () => screen.getByRole("tab", { name: /Saved/ });

beforeEach(() => {
  listFavorites.mockClear();
  addFavorite.mockClear();
  removeFavorite.mockClear();
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

  it("explains the empty Saved tab instead of showing a blank list", async () => {
    listFavorites.mockResolvedValueOnce([]);
    view();
    await screen.findByText("台風が九州に接近");

    fireEvent.click(savedTab());
    expect(await screen.findByText(/No saved articles yet/)).toBeTruthy();
  });
});
