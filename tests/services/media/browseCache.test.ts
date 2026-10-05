// @vitest-environment jsdom
// The Articles browse is kept for the user's day: re-entering the tab (e.g. after a quiz
// took it over) shows the same batch; a new day, user or language draws a new one.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { __resetBrowseMemory, browseKey, readBrowse, writeBrowse } from "@/services/media/browseCache";
import type { Headline } from "@/services/media/mediawiki";

const batch = (n: string): Headline[] => [{ title: `t${n}`, url: `https://x/${n}`, summary: "s" } as Headline];

beforeEach(() => {
  __resetBrowseMemory();
  localStorage.clear();
});

describe("browseKey", () => {
  it("is per user, wiki, language and LOCAL calendar day", () => {
    const base = { userId: "u", site: "wikinews" as const, lang: "JA", now: new Date(2026, 8, 28, 23, 59) };
    expect(browseKey(base)).toBe("u|wikinews|JA|2026-09-28");
    expect(browseKey({ ...base, now: new Date(2026, 8, 29, 0, 1) })).toBe("u|wikinews|JA|2026-09-29");
    expect(browseKey({ ...base, userId: "v" })).not.toBe(browseKey(base));
    expect(browseKey({ ...base, lang: "EN" })).not.toBe(browseKey(base));
  });
});

describe("topics", () => {
  const base = { userId: "u", site: "wikinews" as const, lang: "JA", now: new Date(2026, 8, 28) };

  it("'all' is the plain key, so batches kept before topics existed still read", () => {
    expect(browseKey({ ...base, topic: "all" })).toBe(browseKey(base));
    expect(browseKey({ ...base, topic: "sports" })).toBe("u|wikinews|JA|2026-09-28|sports");
  });

  it("each topic keeps its own batch for the day — switching and back shows the same stories", () => {
    const all = browseKey(base);
    const sports = browseKey({ ...base, topic: "sports" });
    writeBrowse(all, batch("a"));
    writeBrowse(sports, batch("s"));
    expect(readBrowse(all)).toEqual(batch("a"));
    expect(readBrowse(sports)).toEqual(batch("s"));
    __resetBrowseMemory(); // and across an app restart
    expect(readBrowse(all)).toEqual(batch("a"));
    expect(readBrowse(sports)).toEqual(batch("s"));
  });

  it("a new day drops every topic's batch from the day before", () => {
    writeBrowse(browseKey({ ...base, topic: "sports" }), batch("s"));
    writeBrowse(browseKey({ ...base, now: new Date(2026, 8, 29) }), batch("n"));
    expect(readBrowse(browseKey({ ...base, topic: "sports" }))).toBeNull();
  });

  it("reads a batch stored in the pre-topics shape", () => {
    localStorage.setItem("dino.media.browse", JSON.stringify({ key: browseKey(base), items: batch("old") }));
    expect(readBrowse(browseKey(base))).toEqual(batch("old"));
  });
});

describe("readBrowse / writeBrowse", () => {
  it("returns the kept batch for the same key only", () => {
    writeBrowse("k1", batch("a"));
    expect(readBrowse("k1")).toEqual(batch("a"));
    expect(readBrowse("k2")).toBeNull();
  });

  it("survives the in-memory copy being lost (an app restart the same day)", () => {
    writeBrowse("k1", batch("a"));
    __resetBrowseMemory();
    expect(readBrowse("k1")).toEqual(batch("a"));
  });

  it("a Refresh (a new write) replaces the kept batch", () => {
    writeBrowse("k1", batch("a"));
    writeBrowse("k1", batch("b"));
    __resetBrowseMemory();
    expect(readBrowse("k1")).toEqual(batch("b"));
  });

  it("still works in memory when storage throws", () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    writeBrowse("k1", batch("a"));
    expect(readBrowse("k1")).toEqual(batch("a"));
    spy.mockRestore();
  });
});
