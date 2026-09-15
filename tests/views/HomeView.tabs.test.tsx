// @vitest-environment jsdom
// The tab bar: FOUR tabs, and Articles is not one of them.
//
// A tab bar is the app's whole map, so its shape is worth pinning: adding a fifth
// entry back is a product decision, not a refactor, and this fails loudly if one
// reappears by accident. The counterpart — that Articles is still REACHABLE from
// Learn — is pinned in LearnView.articles.test.tsx; together they say the surface
// moved rather than went away.
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { LocaleProvider } from "@/i18n";
import { resetStickyState } from "@/hooks/useStickyState";

// Each tab's view is a whole feature (kuromoji, Supabase, the reader); the tab BAR is
// what's under test, so they're stubbed to a name.
vi.mock("@/views/TranslateView", () => ({ TranslateView: () => <p>TRANSLATE</p> }));
vi.mock("@/views/ListView", () => ({ ListView: () => <p>LISTS</p> }));
vi.mock("@/views/LearnView", () => ({ LearnView: () => <p>LEARN</p> }));
vi.mock("@/views/FlashcardView", () => ({ FlashcardView: () => <p>REVIEW</p> }));

import { HomeView } from "@/views/HomeView";

const tabNames = () =>
  Array.from(document.querySelectorAll("nav.tabs .tab")).map((b) => b.textContent?.trim());

beforeEach(() => resetStickyState());
afterEach(cleanup);

describe("HomeView — tab bar", () => {
  it("shows exactly Translate · Lists · Learn · Review", async () => {
    render(
      <LocaleProvider>
        <HomeView userId="u" />
      </LocaleProvider>,
    );
    await waitFor(() => expect(screen.getByText("TRANSLATE")).toBeTruthy());

    expect(tabNames()).toEqual(["Translate", "Lists", "Learn", "Review"]);
  });

  it("has no Media tab — Articles lives behind Learn now", async () => {
    render(
      <LocaleProvider>
        <HomeView userId="u" />
      </LocaleProvider>,
    );
    await waitFor(() => expect(screen.getByText("TRANSLATE")).toBeTruthy());

    expect(screen.queryByRole("button", { name: /Media/ })).toBeNull();
  });
});
