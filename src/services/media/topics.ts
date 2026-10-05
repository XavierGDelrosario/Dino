// Topics for the Articles browse — a headline batch drawn from ONE Wikinews category
// instead of the whole wiki.
//
// Each edition files its articles under its own category names, so a topic is a small
// map per language, not a translation. Sizes (direct article members, checked against
// the live API 2026-10-05; every edition is a frozen archive, so they won't move):
//   ja  スポーツ 902 · 事件 704 · 政治 587 · 文化 513 · 経済 410 · 気象 329 · 学術 222 · 災害 191
//   en  Politics and conflicts 7,850 · Crime and law 4,552 · Disasters and accidents 2,817 ·
//       Sports 2,462 · Economy and business 2,365 · Culture and entertainment 2,214 ·
//       Science and technology 2,106 · Weather 534
//
// The API can't draw at random INSIDE a category (generator=random takes no category,
// and categorymembers only sorts by name or date). So a topic's titles are listed once —
// a few hundred titles is one ~45 KB request — shuffled, and dealt from in batches: no
// headline repeats until the topic has been gone through. Only the dealt batch has its
// intro fetched.
import { parseHeadlines, wikiApiBase, type Headline, type WikiSite } from "./mediawiki";

export const TOPICS = [
  "sports",
  "weather",
  "disasters",
  "politics",
  "economy",
  "culture",
  "crime",
  "science",
] as const;
export type Topic = (typeof TOPICS)[number];

const CATEGORY: Record<string, Record<Topic, string>> = {
  JA: {
    sports: "スポーツ",
    weather: "気象",
    disasters: "災害",
    politics: "政治",
    economy: "経済",
    culture: "文化",
    crime: "事件",
    science: "学術",
  },
  EN: {
    sports: "Sports",
    weather: "Weather",
    disasters: "Disasters and accidents",
    politics: "Politics and conflicts",
    economy: "Economy and business",
    culture: "Culture and entertainment",
    crime: "Crime and law",
    science: "Science and technology",
  },
};

/** The topics this corpus can be browsed by ([] = no topic picker). */
export function topicsFor(site: WikiSite, lang: string): readonly Topic[] {
  return site === "wikinews" && CATEGORY[lang.toUpperCase()] ? TOPICS : [];
}

const PAGE = 500; // the API's ceiling per request
/** Newest-filed first, capped: 2,000 titles is every Japanese topic whole, and plenty
 *  of the largest English ones without listing 7,850 titles to show twelve. */
const MAX_PAGES = 4;

/** A topic's titles in dealing order, and how far through them we are. */
const pools = new Map<string, { titles: string[]; next: number }>();

/** Test seam: forget every listed topic. */
export function __resetTopicPools(): void {
  pools.clear();
}

function shuffle<T>(items: T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function getJson(url: URL): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Wiki request failed (${res.status})`);
  return res.json();
}

async function listCategory(site: WikiSite, lang: string, category: string): Promise<string[]> {
  const titles: string[] = [];
  let cont: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL(wikiApiBase(site, lang));
    url.search = new URLSearchParams({
      action: "query",
      list: "categorymembers",
      cmtitle: `Category:${category}`,
      cmnamespace: "0", // articles only (skip subcategories and files)
      cmlimit: String(PAGE),
      cmprop: "title",
      cmsort: "timestamp",
      cmdir: "desc",
      ...(cont ? { cmcontinue: cont } : {}),
      format: "json",
      origin: "*",
    }).toString();
    const json = (await getJson(url)) as {
      query?: { categorymembers?: { title?: unknown }[] };
      continue?: { cmcontinue?: string };
    };
    for (const m of json.query?.categorymembers ?? []) {
      if (typeof m.title === "string" && m.title) titles.push(m.title);
    }
    cont = json.continue?.cmcontinue;
    if (!cont) break;
  }
  return titles;
}

/**
 * A batch of headlines from one topic (the Articles browse with a topic picked, and its
 * Refresh). Each call deals the NEXT titles of that topic's shuffled list, so a Refresh
 * shows new stories until the topic runs out, then reshuffles. Throws on a failed request.
 */
export async function topicHeadlines({
  site = "wikinews",
  lang = "JA",
  topic,
  limit = 12,
}: {
  site?: WikiSite;
  lang?: string;
  topic: Topic;
  limit?: number;
}): Promise<Headline[]> {
  const category = CATEGORY[lang.toUpperCase()]?.[topic];
  if (site !== "wikinews" || !category) return [];

  const key = `${site}|${lang}|${topic}`;
  let pool = pools.get(key);
  if (!pool) {
    pool = { titles: shuffle(await listCategory(site, lang, category)), next: 0 };
    pools.set(key, pool);
  }
  if (pool.next + limit > pool.titles.length && pool.next > 0) {
    pool.titles = shuffle(pool.titles); // gone through — deal it again in a new order
    pool.next = 0;
  }
  const picks = pool.titles.slice(pool.next, pool.next + limit);
  pool.next += picks.length;
  if (picks.length === 0) return [];

  const url = new URL(wikiApiBase(site, lang));
  url.search = new URLSearchParams({
    action: "query",
    prop: "extracts",
    exintro: "1",
    explaintext: "1",
    exsentences: "2",
    exlimit: "max", // intros come 20 to a request; a batch is 12
    titles: picks.join("|"),
    format: "json",
    origin: "*",
  }).toString();
  const byTitle = new Map(parseHeadlines(await getJson(url), site, lang).map((h) => [h.title, h]));
  // The API answers in page-id order; keep the shuffled one.
  return picks.map((t) => byTitle.get(t)).filter((h): h is Headline => !!h);
}
