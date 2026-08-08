// One-off audit: what does the 固有名詞-組織 demotion actually remove from the Media
// word list? Fetches N random Japanese Wikinews articles through the REAL client
// (stripArticleApparatus + capToSentence), tokenizes each with kuromoji, and reports
// every organization-tagged token — flagging the ones that HAVE a JMdict entry, since
// those are the only ones the filter costs us (entry-less tokens were already dropped
// from the word list).
//
//   npx tsx scripts/audit-proper-nouns.ts [articles] [jmdict-surfaces.txt]
//
// The surface file is one JMdict writing/reading per line (extracted from the seed).
import { readFileSync } from "node:fs";
import kuromoji, { type IpadicFeatures } from "kuromoji";
import { fetchArticle, randomHeadlines } from "../src/services/media/mediawiki";

const ARTICLES = Number(process.argv[2] ?? 60);
const SURFACES = process.argv[3] ?? "";

const surfaces: Set<string> = SURFACES
  ? new Set(readFileSync(SURFACES, "utf8").split("\n").filter(Boolean))
  : new Set();

// Wikimedia rate-limits (429) requests with no descriptive User-Agent — the browser
// sends its own, Node does not. Wrap fetch to add one, and pace the calls.
const realFetch = globalThis.fetch;
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
  realFetch(input, {
    ...init,
    headers: { ...(init?.headers ?? {}), "User-Agent": "DinoVocabAudit/1.0 (dev script)" },
  })) as typeof fetch;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retry with exponential back-off — Wikimedia 429s an anonymous burst. */
async function retry<T>(fn: () => Promise<T>, attempts = 6): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await sleep(3000 * 2 ** i);
    }
  }
  throw last;
}

function tokenizer() {
  return new Promise<kuromoji.Tokenizer<IpadicFeatures>>((resolve, reject) => {
    kuromoji.builder({ dicPath: "node_modules/kuromoji/dict" }).build((err, tk) =>
      err ? reject(err) : resolve(tk),
    );
  });
}

interface Hit {
  surface: string;
  occurrences: number;
  articles: Set<string>;
  inJmdict: boolean;
}

async function main() {
  const tk = await tokenizer();
  // generator=random caps at 10 per call for anonymous clients — batch up to ARTICLES.
  const seen = new Set<string>();
  const heads: { title: string }[] = [];
  while (heads.length < ARTICLES) {
    const batch = await retry(() => randomHeadlines({ limit: 10 }));
    for (const h of batch) {
      if (!seen.has(h.title) && heads.length < ARTICLES) {
        seen.add(h.title);
        heads.push(h);
      }
    }
    await sleep(300);
  }
  console.log(`fetched ${heads.length} random Wikinews headlines\n`);

  const org = new Map<string, Hit>();
  const person = new Map<string, Hit>();
  let contentTokens = 0; // content words AFTER the demotion (the word-list universe)
  let lostTokens = 0; // org tokens that had a JMdict entry (what we now hide)

  let done = 0;
  for (const h of heads) {
    const art = await retry(() => fetchArticle({ title: h.title }));
    await sleep(1000); // stay under Wikimedia's anonymous rate limit
    if (!art?.text) continue;
    if (++done % 10 === 0) console.error(`  …${done}/${heads.length} articles`);
    for (const t of tk.tokenize(art.text)) {
      if (t.pos === "記号" || !/[\p{L}\p{N}]/u.test(t.surface_form)) continue;
      const proper = t.pos === "名詞" && t.pos_detail_1 === "固有名詞";
      const isOrg = proper && t.pos_detail_2 === "組織";
      const isPerson = proper && t.pos_detail_2 === "人名";
      if (isOrg || isPerson) {
        const bucket = isOrg ? org : person;
        const hit = bucket.get(t.surface_form) ?? {
          surface: t.surface_form,
          occurrences: 0,
          articles: new Set<string>(),
          inJmdict: surfaces.has(t.surface_form),
        };
        hit.occurrences++;
        hit.articles.add(art.title);
        bucket.set(t.surface_form, hit);
        if (isOrg && hit.inJmdict) lostTokens++;
        continue;
      }
      if (["名詞", "動詞", "形容詞", "副詞", "連体詞", "感動詞", "接頭詞"].includes(t.pos)) {
        contentTokens++;
      }
    }
  }

  const rows = [...org.values()].sort((a, b) => b.occurrences - a.occurrences);
  const known = rows.filter((r) => r.inJmdict);
  const unknown = rows.filter((r) => !r.inJmdict);

  console.log(`content tokens kept: ${contentTokens}`);
  console.log(`組織 tokens demoted: ${lostTokens + unknown.reduce((n, r) => n + r.occurrences, 0)}`);
  console.log(
    `  · with a JMdict entry (REAL loss): ${lostTokens} tokens / ${known.length} distinct` +
      ` — ${((lostTokens / (contentTokens + lostTokens)) * 100).toFixed(2)}% of content tokens`,
  );
  console.log(
    `  · no JMdict entry (already dropped): ${unknown.reduce((n, r) => n + r.occurrences, 0)} tokens / ${unknown.length} distinct`,
  );
  console.log(`人名 demoted: ${[...person.values()].reduce((n, r) => n + r.occurrences, 0)} tokens / ${person.size} distinct\n`);

  console.log("=== 組織 WITH a JMdict entry (these vanish from the word list) ===");
  for (const r of known) console.log(`${r.occurrences}\t${r.articles.size}\t${r.surface}`);
  console.log("\n=== 組織 with NO JMdict entry (no change — never listed) ===");
  for (const r of unknown.slice(0, 60)) console.log(`${r.occurrences}\t${r.articles.size}\t${r.surface}`);
  if (unknown.length > 60) console.log(`… +${unknown.length - 60} more`);
}

void main();
