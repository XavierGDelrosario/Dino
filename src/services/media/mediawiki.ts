// Generic MediaWiki client — the input seam for the generic analysis surface
// (ArticleView). Every MediaWiki project exposes the SAME CORS-open API, so one client
// serves Wikipedia, Wikinews, … — pick the `site`.
//
// The Media tab browses Japanese Wikinews (a ~4k-article archive, no new stories, which
// is fine as a study corpus): random headlines with a Refresh for a new batch.
//
// All wiki text is openly licensed (CC BY-SA / CC BY 2.5), so the real prose is shown
// with attribution + a link back. A fetched article is reduced to its NEWS BODY by
// `stripArticleApparatus` — citation lists and related-article links are apparatus,
// not reading material.

export type WikiSite = "wikipedia" | "wikinews";

interface SiteConfig {
  /** Subdomain segment: <lang>.<segment>.org */
  segment: string;
  /** Credit label shown alongside the prose (license line). */
  attribution: string;
}

const SITES: Record<WikiSite, SiteConfig> = {
  wikipedia: { segment: "wikipedia", attribution: "Wikipedia · CC BY-SA" },
  wikinews: { segment: "wikinews", attribution: "Wikinews · CC BY 2.5" },
};

/** App language code → wiki subdomain. Defaults to Japanese. */
const SUBLANG: Record<string, string> = { JA: "ja", EN: "en", KO: "ko", ZH: "zh" };
const langSub = (lang: string) => SUBLANG[lang.toUpperCase()] ?? "ja";
const host = (site: WikiSite, lang: string) => `${langSub(lang)}.${SITES[site].segment}.org`;
const apiBase = (site: WikiSite, lang: string) => `https://${host(site, lang)}/w/api.php`;

/** Source attribution for studied media text — a credit label + link-back. */
export interface MediaSource {
  label: string;
  url: string;
  /** License line for the source (e.g. "Wikinews · CC BY 2.5"). */
  attribution: string;
}

/** A browse item: a headline + one–two-sentence intro + its link. */
export interface Headline {
  title: string;
  summary: string;
  url: string;
}

/** A studied article: full plain text + its canonical URL + license line. */
export interface Article {
  title: string;
  text: string;
  url: string;
  attribution: string;
}

/** Canonical article URL — for the attribution / link-back. */
export function articleUrl(title: string, site: WikiSite = "wikinews", lang = "JA"): string {
  return `https://${host(site, lang)}/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;
}

/** Strip HTML tags + entities + collapse whitespace (search/extract snippets). */
export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&#\d+;/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Parse a generator/list response's pages into an unsorted array. */
function pagesOf(json: unknown): Record<string, unknown>[] {
  const pages = (json as { query?: { pages?: unknown } })?.query?.pages;
  return pages && typeof pages === "object" ? (Object.values(pages) as Record<string, unknown>[]) : [];
}

/** Parse a `generator=random` + extracts response into headlines. PURE. */
export function parseHeadlines(json: unknown, site: WikiSite = "wikinews", lang = "JA"): Headline[] {
  return pagesOf(json)
    .map((p) => ({
      title: typeof p.title === "string" ? p.title : "",
      summary: typeof p.extract === "string" ? stripHtml(p.extract) : "",
      url: articleUrl(typeof p.title === "string" ? p.title : "", site, lang),
    }))
    .filter((h) => h.title);
}

/** Parse a `prop=extracts` response's first page → its resolved title + text. PURE. */
export function parsePage(json: unknown): { title: string; extract: string } {
  const first = pagesOf(json)[0] ?? null;
  return {
    title: typeof first?.title === "string" ? first.title : "",
    extract: typeof first?.extract === "string" ? first.extract : "",
  };
}

// ── Article body vs apparatus ──────────────────────────────────────────────
// `explaintext` strips wiki MARKUP but keeps every SECTION, so an article still ends in
// citation lists (出典 / 情報源) and related-article links — newspaper names, dates and
// headlines that aren't the story, and they can outweigh the prose.
//
// Dropped by HEADING, never wholesale: a sampled article had a real news section
// (日本選手の成績など), so "drop every section" would delete body text. Headings are
// matched narrowly for the same reason — 関連 only counts as apparatus in the fixed
// shapes Wikinews uses for link lists, not on its own.
const APPARATUS_HEADINGS: RegExp[] = [
  /^(出典|情報源|参考資料|参考文献|参考|脚注|註|注釈|補足|典拠)$/,
  /関連(する)?(記事|項目|ニュース|報道|画像)/,
  /^ウィキ(ニュース|ペディア|メディア)/,
  /^外部リンク/,
  /^(ライセンス|著作権|カテゴリ)/,
  // English-language projects (the client is generic over MediaWiki sites).
  /^(sources?|references?|external links?|see also|further reading|notes?|bibliography|citations?|related( news| articles?| stories)?)$/i,
];

/** True when a section heading introduces apparatus rather than news prose. */
function isApparatusHeading(heading: string): boolean {
  const h = heading.trim();
  return APPARATUS_HEADINGS.some((re) => re.test(h));
}

// A plain-text section heading as `explaintext` renders it: == Heading ==
const HEADING_LINE = /^\s*(={2,6})\s*(.+?)\s*\1\s*$/;

/**
 * Drop the apparatus sections from a plain-text article, keeping the news.
 *
 * A dropped section takes its SUBSECTIONS with it (a deeper heading under 出典 is
 * still apparatus). Kept headings lose their `==` markers but keep their text —
 * the heading is real prose the reader can study. Runs of blank lines collapse so
 * the removal leaves no gaps.
 *
 * PURE. Text before the first heading (the lead, and Wikinews' 【date】 dateline)
 * is always kept.
 */
export function stripArticleApparatus(text: string): string {
  const out: string[] = [];
  /** Heading level of the section being dropped, or null when keeping. */
  let dropLevel: number | null = null;

  for (const line of text.split("\n")) {
    const match = HEADING_LINE.exec(line);
    if (match) {
      const level = match[1].length;
      const heading = match[2];
      // Deeper heading inside a dropped section → still dropped.
      if (dropLevel !== null && level > dropLevel) continue;
      if (isApparatusHeading(heading)) {
        dropLevel = level;
        continue;
      }
      dropLevel = null;
      out.push(heading); // keep the words, lose the == markup
      continue;
    }
    if (dropLevel === null) out.push(line);
  }

  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n") // the removals leave 3+ newlines behind
    .trim();
}

// Browser-side safety cap on how much of a very long article we analyze (kuromoji +
// per-word lookups run client-side; no MT gloss is made — the summary uses skipGloss).
const MAX_EXTRACT_CHARS = 20000;

/** Truncate to the last sentence boundary (。！？.) at/under `max` chars. PURE. */
export function capToSentence(text: string, max = MAX_EXTRACT_CHARS): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  const slice = trimmed.slice(0, max);
  const cut = Math.max(
    slice.lastIndexOf("。"),
    slice.lastIndexOf("！"),
    slice.lastIndexOf("？"),
    slice.lastIndexOf(". "),
  );
  return (cut > 0 ? slice.slice(0, cut + 1) : slice).trim();
}

/**
 * A batch of RANDOM article headlines (the Media browse + its Refresh). Browser
 * fetch (CORS-open); throws on non-2xx. Order is random by construction.
 */
export async function randomHeadlines({
  site = "wikinews",
  lang = "JA",
  limit = 12,
}: {
  site?: WikiSite;
  lang?: string;
  limit?: number;
} = {}): Promise<Headline[]> {
  const url = new URL(apiBase(site, lang));
  url.search = new URLSearchParams({
    action: "query",
    generator: "random",
    grnnamespace: "0", // articles only (skip talk/templates)
    grnlimit: String(limit),
    prop: "extracts",
    exintro: "1",
    explaintext: "1",
    exsentences: "2",
    format: "json",
    origin: "*",
  }).toString();
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Wiki request failed (${res.status})`);
  return parseHeadlines(await res.json(), site, lang);
}

/**
 * Fetch the FULL article as plain text + its canonical URL + license (capped for
 * browser safety). Follows redirects, so title/url may differ from the request.
 */
export async function fetchArticle({
  site = "wikinews",
  lang = "JA",
  title,
}: {
  site?: WikiSite;
  lang?: string;
  title: string;
}): Promise<Article> {
  const url = new URL(apiBase(site, lang));
  url.search = new URLSearchParams({
    action: "query",
    prop: "extracts",
    explaintext: "1", // whole body, not just the lead
    redirects: "1",
    titles: title,
    format: "json",
    origin: "*",
  }).toString();
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Article request failed (${res.status})`);
  const { title: resolved, extract } = parsePage(await res.json());
  const finalTitle = resolved || title;
  return {
    title: finalTitle,
    // Apparatus out FIRST, then cap: the char budget should be spent on prose,
    // not on a citation list that gets dropped anyway.
    text: capToSentence(stripArticleApparatus(extract)),
    url: articleUrl(finalTitle, site, lang),
    attribution: SITES[site].attribution,
  };
}
