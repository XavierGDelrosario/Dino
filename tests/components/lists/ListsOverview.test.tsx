// @vitest-environment jsdom
// The lists INDEX — the vertical replacement for the chip row, and the Lists tab's
// landing screen. What's pinned here is the ordering, which has three rules that are
// easy to break and invisible until someone with a lot of lists complains:
//   - ALL is always first, whatever the axis (it is the whole vocabulary, not a list);
//   - "most" means NEWEST / Z–A on every axis here — the opposite sign to a numeric
//     "most" like confidence, which is exactly the kind of thing that flips silently;
//   - a list with no date on the chosen axis sorts LAST in BOTH directions, rather
//     than as epoch-zero, which would bury real lists under every empty one.
// The counts/bar come straight from list_overview(); the SQL is the integration
// suite's job, so this only asserts the rendering of what it returns.
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { LocaleProvider } from "@/i18n";
import { ListsOverview, type ListSortAxis } from "@/components/lists/ListsOverview";
import type { ListOverview } from "@/services/lists";
import type { SortDir } from "@/components/common/SortControls";

const row = (o: Partial<ListOverview>): ListOverview => ({
  listId: "l1",
  listName: "A list",
  createdAt: "2026-01-01T00:00:00Z",
  lastWordAddedAt: "2026-01-01T00:00:00Z",
  wordCount: 10,
  confidence: [10, 0, 0, 0, 0, 0],
  ...o,
});

const ALL = row({ listId: null, listName: null, wordCount: 100, createdAt: null, lastWordAddedAt: null });

const rows: ListOverview[] = [
  row({ listId: "old", listName: "Oldest", createdAt: "2026-01-05T00:00:00Z", lastWordAddedAt: "2026-02-01T00:00:00Z" }),
  row({ listId: "new", listName: "Newest", createdAt: "2026-06-05T00:00:00Z", lastWordAddedAt: "2026-09-01T00:00:00Z" }),
  row({ listId: "empty", listName: "Never used", createdAt: "2026-03-05T00:00:00Z", lastWordAddedAt: null, wordCount: 0, confidence: [0, 0, 0, 0, 0, 0] }),
  ALL,
];

const view = (axis: ListSortAxis, dir: SortDir, data: ListOverview[] = rows) =>
  render(
    <LocaleProvider>
      <ListsOverview
        rows={data}
        loading={false}
        error={null}
        axis={axis}
        dir={dir}
        onAxis={() => {}}
        onDir={() => {}}
        onOpen={() => {}}
      />
    </LocaleProvider>,
  );

/** The visible names, in rendered order. */
const names = () =>
  screen.getAllByRole("button")
    .filter((b) => b.classList.contains("listcard"))
    .map((b) => within(b).getByText(/.+/, { selector: ".listcard__name" }).textContent);

afterEach(cleanup);

describe("ListsOverview — ordering", () => {
  it("pins ALL first on every axis and direction", () => {
    for (const axis of ["added", "created", "name"] as ListSortAxis[]) {
      for (const dir of ["most", "least"] as SortDir[]) {
        cleanup();
        view(axis, dir);
        expect(names()[0], `${axis}/${dir}`).toBe("All words");
      }
    }
  });

  it("'most' on a date axis is NEWEST first, and 'least' is oldest first", () => {
    view("added", "most");
    expect(names()).toEqual(["All words", "Newest", "Oldest", "Never used"]);
    cleanup();
    view("added", "least");
    expect(names()).toEqual(["All words", "Oldest", "Newest", "Never used"]);
  });

  it("sorts by the list's OWN date on `created`, which orders differently from `added`", () => {
    // Deliberately distinct data: 'Never used' was created between the other two, so an
    // axis mix-up shows up as a position change rather than as an identical list.
    view("created", "most");
    expect(names()).toEqual(["All words", "Newest", "Never used", "Oldest"]);
  });

  it("keeps a list with no date on the axis LAST in both directions", () => {
    // `.at(-1)` is ES2022 and this project's lib target is older — index arithmetic
    // rather than bumping a compiler option for one assertion.
    const last = () => {
      const n = names();
      return n[n.length - 1];
    };
    view("added", "most");
    expect(last()).toBe("Never used");
    cleanup();
    view("added", "least");
    expect(last()).toBe("Never used");
  });

  it("'most' on the name axis is Z–A", () => {
    view("name", "least");
    expect(names()).toEqual(["All words", "Never used", "Newest", "Oldest"]);
    cleanup();
    view("name", "most");
    expect(names()).toEqual(["All words", "Oldest", "Newest", "Never used"]);
  });
});

describe("ListsOverview — rendering", () => {
  it("shows the count for every list, including an empty one", () => {
    view("name", "least");
    expect(screen.getByText("100")).toBeTruthy(); // ALL
    expect(screen.getByText("0")).toBeTruthy(); // the never-used list still appears
  });

  it("draws no confidence bar for an empty list — an all-background bar would read as 'all at zero'", () => {
    const { container } = view("name", "least");
    const cards = [...container.querySelectorAll(".listcard")];
    const empty = cards.find((c) => c.querySelector(".listcard__name")?.textContent === "Never used");
    expect(empty?.querySelector(".listcard__bar")).toBeNull();
    const filled = cards.find((c) => c.querySelector(".listcard__name")?.textContent === "Newest");
    expect(filled?.querySelector(".listcard__bar")).not.toBeNull();
  });

  it("segments the bar by confidence, widths proportional to the counts", () => {
    const { container } = view("name", "least", [
      row({ listId: "x", listName: "Mixed", wordCount: 4, confidence: [1, 0, 0, 0, 0, 3] }),
    ]);
    const segs = [...container.querySelectorAll(".listcard__seg")] as HTMLElement[];
    // Only the two non-zero buckets render — a zero-width segment is not a thing.
    expect(segs).toHaveLength(2);
    expect(segs[0].style.width).toBe("25%");
    expect(segs[1].style.width).toBe("75%");
  });

  it("says nothing is there only when ALL is the only row", () => {
    view("name", "least", [ALL]);
    expect(screen.queryByText(/No lists yet/)).toBeTruthy();
    cleanup();
    view("name", "least");
    expect(screen.queryByText(/No lists yet/)).toBeNull();
  });
});
