// Topic browse: the wiki can't draw at random inside a category, so a topic's titles
// are listed once, shuffled, and dealt in batches — no repeats until it runs out.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { topicHeadlines, topicsFor, TOPICS, __resetTopicPools } from "@/services/media/topics";

const calls: URL[] = [];
let members: string[][] = []; // one entry per categorymembers page

beforeEach(() => {
  __resetTopicPools();
  calls.length = 0;
  members = [["A", "B", "C", "D", "E"]];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: URL | string) => {
      const url = new URL(String(input));
      calls.push(url);
      const q = url.searchParams;
      if (q.get("list") === "categorymembers") {
        const page = q.get("cmcontinue") ? Number(q.get("cmcontinue")) : 0;
        return {
          ok: true,
          json: async () => ({
            query: { categorymembers: (members[page] ?? []).map((title) => ({ title })) },
            ...(page + 1 < members.length ? { continue: { cmcontinue: String(page + 1) } } : {}),
          }),
        };
      }
      const titles = (q.get("titles") ?? "").split("|");
      return {
        ok: true,
        json: async () => ({
          query: { pages: Object.fromEntries(titles.map((t, i) => [i, { title: t, extract: `about ${t}` }])) },
        }),
      };
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const listCalls = () => calls.filter((u) => u.searchParams.get("list") === "categorymembers");

describe("topicsFor", () => {
  it("offers the topics for both Wikinews editions, and none elsewhere", () => {
    expect(topicsFor("wikinews", "JA")).toEqual(TOPICS);
    expect(topicsFor("wikinews", "EN")).toEqual(TOPICS);
    expect(topicsFor("wikinews", "KO")).toEqual([]);
    expect(topicsFor("wikipedia", "JA")).toEqual([]);
  });
});

describe("topicHeadlines", () => {
  it("asks the learning language's wiki for that language's own category name", async () => {
    await topicHeadlines({ lang: "JA", topic: "weather", limit: 2 });
    expect(listCalls()[0].host).toBe("ja.wikinews.org");
    expect(listCalls()[0].searchParams.get("cmtitle")).toBe("Category:気象");
    expect(listCalls()[0].searchParams.get("cmnamespace")).toBe("0");

    await topicHeadlines({ lang: "EN", topic: "disasters", limit: 2 });
    expect(listCalls()[1].host).toBe("en.wikinews.org");
    expect(listCalls()[1].searchParams.get("cmtitle")).toBe("Category:Disasters and accidents");
  });

  it("returns headlines with their intro and link", async () => {
    const batch = await topicHeadlines({ lang: "JA", topic: "sports", limit: 2 });
    expect(batch).toHaveLength(2);
    expect(batch[0].summary).toBe(`about ${batch[0].title}`);
    expect(batch[0].url).toContain("ja.wikinews.org/wiki/");
  });

  it("lists a topic ONCE, and a Refresh deals new stories until it runs out", async () => {
    const seen: string[] = [];
    for (let i = 0; i < 2; i++) {
      seen.push(...(await topicHeadlines({ lang: "JA", topic: "sports", limit: 2 })).map((h) => h.title));
    }
    expect(new Set(seen).size).toBe(4); // no repeats across the two batches
    expect(listCalls()).toHaveLength(1);

    // One title left, a batch of two asked for → gone through: reshuffle and deal again.
    const again = await topicHeadlines({ lang: "JA", topic: "sports", limit: 2 });
    expect(again).toHaveLength(2);
    expect(listCalls()).toHaveLength(1);
  });

  it("follows the category's continuation pages", async () => {
    members = [["A", "B"], ["C", "D"], ["E"]];
    const batch = await topicHeadlines({ lang: "JA", topic: "politics", limit: 5 });
    expect(batch.map((h) => h.title).sort()).toEqual(["A", "B", "C", "D", "E"]);
    expect(listCalls()).toHaveLength(3);
  });

  it("keeps each topic's titles apart", async () => {
    await topicHeadlines({ lang: "JA", topic: "sports", limit: 1 });
    await topicHeadlines({ lang: "JA", topic: "weather", limit: 1 });
    expect(listCalls()).toHaveLength(2);
  });

  it("an empty category is an empty batch, with no intro request", async () => {
    members = [[]];
    expect(await topicHeadlines({ lang: "JA", topic: "science", limit: 3 })).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("throws when the wiki refuses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503 })));
    await expect(topicHeadlines({ lang: "JA", topic: "sports" })).rejects.toThrow("503");
  });
});
