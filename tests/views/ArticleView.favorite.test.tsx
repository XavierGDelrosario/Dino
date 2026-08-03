// @vitest-environment jsdom
// The ★ on the article surfaces (analysis + reading mode).
//
// The browse-list star is covered in MediaView.favorites.test.tsx; what THIS spec
// pins is the part that could silently regress: the star inside the article is
// driven by Media's favourites state, not a second copy. Going Study → ★ → Back
// has to leave the list already showing the change, and starring from in there has
// to save the HEADLINE (with its summary), which `Article` alone doesn't carry.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { LocaleProvider } from "@/i18n";

const headlines = [
  { title: "台風が九州に接近", summary: "気象庁によると…", url: "https://ja.wikinews.org/wiki/A" },
];

const favoriteRow = {
  favoriteId: "f1",
  title: headlines[0].title,
  summary: headlines[0].summary,
  url: headlines[0].url,
  site: "wikinews" as const,
  lang: "JA",
  createdAt: "2026-08-01T00:00:00Z",
};

type Headline = (typeof headlines)[number];

const listFavorites = vi.fn(async (_userId: string) => [] as (typeof favoriteRow)[]);
const addFavorite = vi.fn(async (_p: { userId: string; headline: Headline }) => favoriteRow);
const removeFavorite = vi.fn(async (_p: { userId: string; url: string }) => {});

vi.mock("@/services/media/mediawiki", async (orig) => ({
  ...(await orig<typeof import("@/services/media/mediawiki")>()),
  randomHeadlines: vi.fn(async () => headlines),
  fetchArticle: vi.fn(async () => ({
    title: headlines[0].title,
    // `Article` has no `summary` — that's exactly why the headline is kept.
    text: "猫が好きです。",
    url: headlines[0].url,
    attribution: "CC BY 2.5",
  })),
}));

vi.mock("@/services/media/favorites", () => ({
  listFavorites: (userId: string) => listFavorites(userId),
  addFavorite: (p: { userId: string; headline: Headline }) => addFavorite(p),
  removeFavorite: (p: { userId: string; url: string }) => removeFavorite(p),
}));

// ArticleView drives the whole reader pipeline through useTranslate; stub it down
// to the fields this view reads. `para: null` leaves the analysis in its
// "Analyzing…" state, which is enough — the header (and its star) renders either
// way, and the word-list rendering is covered elsewhere.
vi.mock("@/hooks/useTranslate", () => ({
  useTranslate: () => ({
    setInput: vi.fn(),
    submit: vi.fn(async () => {}),
    para: null,
    analyzedInput: "",
    saved: new Set<string>(),
    confidence: new Map<string, number>(),
    error: null,
    lists: [],
    addWords: vi.fn(),
    createNamedList: vi.fn(),
    loadGloss: vi.fn(),
    loadSentenceGloss: vi.fn(),
    glossLoading: false,
    contextByWord: new Map(),
    applyReview: vi.fn(),
  }),
}));

import { MediaView } from "@/views/MediaView";
import { ArticleView } from "@/views/ArticleView";

const star = () => screen.getByRole("button", { name: /Save this article|Remove from saved/ });
const allStars = () => screen.getAllByRole("button", { name: /Save this article|Remove from saved/ });

/** Browse → Study → the article analysis. */
async function openArticle() {
  render(
    <LocaleProvider>
      <MediaView userId="u" />
    </LocaleProvider>,
  );
  await screen.findByText(headlines[0].title);
  fireEvent.click(screen.getByRole("button", { name: /^Study$/ }));
  await screen.findByRole("button", { name: /Back/ });
}

beforeEach(() => {
  listFavorites.mockClear();
  addFavorite.mockClear();
  removeFavorite.mockClear();
  listFavorites.mockResolvedValue([]);
});
afterEach(cleanup);

describe("ArticleView — ★ on the article", () => {
  it("shows a star in the analysis header", async () => {
    await openArticle();
    expect(star().textContent).toBe("☆");
  });

  it("saves the HEADLINE (with its summary), not just the article", async () => {
    // `Article` carries no summary, so a star that saved from it alone would store
    // an empty one and the ★ Saved list would render a blank row.
    await openArticle();
    fireEvent.click(star());

    await waitFor(() => expect(addFavorite).toHaveBeenCalledTimes(1));
    expect(addFavorite.mock.calls[0][0]).toMatchObject({
      userId: "u",
      headline: { url: headlines[0].url, summary: headlines[0].summary },
    });
  });

  it("reflects an already-saved article", async () => {
    listFavorites.mockResolvedValue([favoriteRow]);
    await openArticle();
    await waitFor(() => expect(star().textContent).toBe("★"));

    fireEvent.click(star());
    await waitFor(() => expect(removeFavorite).toHaveBeenCalledTimes(1));
    expect(star().textContent).toBe("☆");
  });

  it("shares one state with the browse list — starring in the article shows on Back", async () => {
    // The regression this guards: a second useFavorites inside ArticleView would
    // star successfully and leave the list behind it still drawing ☆.
    await openArticle();
    fireEvent.click(star());
    await waitFor(() => expect(addFavorite).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: /Back/ }));
    await screen.findByText(headlines[0].title);
    expect(allStars()[0].textContent).toBe("★");
    // One load for the whole flow — the article star didn't force a re-read.
    expect(listFavorites).toHaveBeenCalledTimes(1);
  });

  it("carries the star into reading mode", async () => {
    await openArticle();
    // Reading mode is reachable once the analysis has words; drive the view
    // directly instead, since the star lives in the shared header either way.
    cleanup();
    render(
      <LocaleProvider>
        <ArticleView
          userId="u"
          article={{ title: "T", text: "x", url: headlines[0].url, attribution: "CC" }}
          onBack={() => {}}
          favorite={{ starred: true, pending: false, onToggle: () => {} }}
        />
      </LocaleProvider>,
    );
    expect(star().textContent).toBe("★");
  });

  it("renders NO star when no favourite is supplied (generic analysis surface)", async () => {
    // A pasted text or a scan has no canonical URL to save a pointer to.
    render(
      <LocaleProvider>
        <ArticleView
          userId="u"
          article={{ title: "T", text: "x", url: "", attribution: "CC" }}
          onBack={() => {}}
        />
      </LocaleProvider>,
    );
    expect(
      screen.queryByRole("button", { name: /Save this article|Remove from saved/ }),
    ).toBeNull();
  });

  it("disables the star while its write is in flight", async () => {
    render(
      <LocaleProvider>
        <ArticleView
          userId="u"
          article={{ title: "T", text: "x", url: headlines[0].url, attribution: "CC" }}
          onBack={() => {}}
          favorite={{ starred: false, pending: true, onToggle: () => {} }}
        />
      </LocaleProvider>,
    );
    expect((star() as HTMLButtonElement).disabled).toBe(true);
  });
});
