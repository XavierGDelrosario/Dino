// @vitest-environment jsdom
// The Articles browse can be narrowed to one Wikinews topic. "All" is the old random
// draw; a topic draws from that category, and each keeps its own batch for the day.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import type { Headline } from "@/services/media/mediawiki";
import { LocaleProvider } from "@/i18n";

const h = (title: string): Headline => ({ title, summary: "s", url: `https://x/${title}` });
const randomHeadlines = vi.fn(async (_p?: unknown) => [h("random story")]);
const topicHeadlines = vi.fn(async (p: { topic: string }) => [h(`${p.topic} story`)]);

vi.mock("@/services/media/mediawiki", async (orig) => ({
  ...(await orig<typeof import("@/services/media/mediawiki")>()),
  randomHeadlines: (p?: unknown) => randomHeadlines(p),
  fetchArticle: vi.fn(),
}));
vi.mock("@/services/media/topics", async (orig) => ({
  ...(await orig<typeof import("@/services/media/topics")>()),
  topicHeadlines: (p: { topic: string }) => topicHeadlines(p),
}));
vi.mock("@/services/media/favorites", () => ({
  listFavorites: vi.fn(async () => []),
  addFavorite: vi.fn(),
  removeFavorite: vi.fn(),
}));
vi.mock("@/views/ArticleView", () => ({ ArticleView: () => null }));

import { MediaView } from "@/views/MediaView";
import { __resetBrowseMemory } from "@/services/media/browseCache";
import { resetStickyState } from "@/hooks/useStickyState";

const view = (learning: "JA" | "EN" = "JA") =>
  render(
    <LocaleProvider>
      <MediaView userId="u" langs={{ learning, native: learning === "JA" ? "EN" : "JA" }} ready />
    </LocaleProvider>,
  );

beforeEach(() => {
  __resetBrowseMemory();
  localStorage.clear();
  resetStickyState();
  randomHeadlines.mockClear();
  topicHeadlines.mockClear();
});
afterEach(cleanup);

describe("MediaView — topics", () => {
  it("starts on All, with the whole-wiki random draw", async () => {
    view();
    await screen.findByText("random story");
    expect(screen.getByRole("button", { name: "All" }).getAttribute("aria-pressed")).toBe("true");
    expect(topicHeadlines).not.toHaveBeenCalled();
  });

  it("picking a topic draws from that topic, in the corpus being browsed", async () => {
    view("EN");
    await screen.findByText("random story");
    fireEvent.click(screen.getByRole("button", { name: "Sports" }));

    await screen.findByText("sports story");
    expect(screen.queryByText("random story")).toBeNull();
    expect(topicHeadlines).toHaveBeenCalledWith(
      expect.objectContaining({ site: "wikinews", lang: "EN", topic: "sports" }),
    );
  });

  it("going back to a topic shows the batch it had, without drawing again", async () => {
    view();
    await screen.findByText("random story");
    fireEvent.click(screen.getByRole("button", { name: "Weather" }));
    await screen.findByText("weather story");
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    await screen.findByText("random story");
    fireEvent.click(screen.getByRole("button", { name: "Weather" }));
    await screen.findByText("weather story");

    expect(randomHeadlines).toHaveBeenCalledTimes(1);
    expect(topicHeadlines).toHaveBeenCalledTimes(1);
  });

  it("Refresh draws a new batch for the topic that is picked", async () => {
    view();
    await screen.findByText("random story");
    fireEvent.click(screen.getByRole("button", { name: "Disasters" }));
    await screen.findByText("disasters story");
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    await waitFor(() => expect(topicHeadlines).toHaveBeenCalledTimes(2));
    expect(randomHeadlines).toHaveBeenCalledTimes(1);
  });

  it("remembers the topic when the view is unmounted and comes back (a quiz took the tab)", async () => {
    const first = view();
    await screen.findByText("random story");
    fireEvent.click(screen.getByRole("button", { name: "Politics" }));
    await screen.findByText("politics story");
    first.unmount();

    view();
    await screen.findByText("politics story");
    expect(screen.getByRole("button", { name: "Politics" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("the Saved list has no topic picker", async () => {
    view();
    await screen.findByText("random story");
    fireEvent.click(screen.getByRole("tab", { name: /Saved/ }));
    expect(screen.queryByRole("button", { name: "Sports" })).toBeNull();
  });
});
