// The kuromoji gate for data/sense_examples/ja.tsv — run it BEFORE ingesting.
//
// WHY A GATE: we author this corpus, so rather than making the parser smarter we pick
// sentences that suit the parser we have. Examples and definitions render through
// ParagraphReader, so every word in them is segmented, furigana'd, coloured and
// tappable — a mis-segmented sentence doesn't just look wrong, it produces unaddable
// fragments and wrong furigana on a surface whose whole promise is that you can tap any
// word. Rewriting the sentence is cheap; shipping it is not.
//
// THE CHECKS:
//   1. The target survives as ONE token with the right lemma (the 柔軟剤 fragment class).
//   2. Its reading matches the AUTHORITATIVE one — kuromoji mis-reads short fragments.
//   3. No orphan content words: every content-POS token resolves to a JMdict entry.
//   4. Token offsets round-trip into the source string.
// All four apply to the DEFINITION too — same renderer, same risk.
//
// 1–3 need the dictionary and SELF-SKIP without one; 4 and the structural rules run
// everywhere, which is what makes this usable as a plain unit test in CI.
//
// USAGE (from the repo root — kuromoji's dicPath is relative):
//   npx tsx scripts/validate-sense-examples.ts
//   DATABASE_URL='postgresql://…' npx tsx scripts/validate-sense-examples.ts   # full gate
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Client } from "pg";
import { analyze, isContentPos, type AnalyzedToken } from "../src/services/language/analyze";
import { lemmaCandidates } from "../supabase/functions/translate/_lib";
import { parseSenseExamples, entryIdFromRef, TSV_PATH, TSV_URL, type SenseExample } from "./lib/senseExamples";

const DEFAULT_DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

export interface Failure {
  line: number;
  check: string;
  message: string;
}

/** The authoritative headword of an entry, as JMdict has it. */
export interface Headword {
  writing: string;
  reading: string | null;
}

/**
 * Prove the REAL engine is running before trusting a single result. `analyzeJapanese`
 * catches a kuromoji load failure and quietly degrades to Intl.Segmenter — boundaries
 * only — so every check would pass vacuously and the gate would report a clean corpus
 * it never parsed. Segmenter output has no readings, so one probe separates them.
 */
export async function assertRealAnalyzer(): Promise<void> {
  const tokens = await analyze("今日は雨が降る", "JA");
  if (!tokens.some((t) => t.reading !== null)) {
    throw new Error(
      "kuromoji is NOT loaded (no readings) — the gate would pass vacuously. " +
        "Run from the repo root so node_modules/kuromoji/dict resolves.",
    );
  }
}

/**
 * Run the parser-independent checks over one field. `headword` is optional: without the
 * dictionary the offsets can still be proven sane, which is the check protecting
 * highlight ranges in the reader.
 */
export async function checkField(
  row: SenseExample,
  field: "example" | "definition",
  text: string,
  headword: Headword | null,
  resolves: ((surface: string) => boolean) | null,
): Promise<Failure[]> {
  const out: Failure[] = [];
  const at = (check: string, message: string) => out.push({ line: row.line, check, message });
  const tokens = await analyze(text, "JA");

  // ── 4. offsets round-trip ────────────────────────────────────────────────────
  for (const t of tokens) {
    if (text.slice(t.start, t.end) !== t.text) {
      at("offsets", `${field}: token "${t.text}" does not round-trip at [${t.start},${t.end})`);
      break; // one report per field — they all share a cause
    }
  }

  // ── 1 + 2. the target survives, and reads correctly ──────────────────────────
  // Only meaningful for the EXAMPLE: a definition explains the word, it is not
  // required to USE it (and often shouldn't — a circular definition).
  if (headword && field === "example") {
    const { writing, reading } = headword;
    const hit = tokens.find(
      (t) => t.text === writing || t.lemma === writing || (reading !== null && (t.text === reading || t.lemma === reading)),
    );
    if (!hit) {
      // In the string but not as a token = kuromoji split it, which is the exact
      // failure this check exists for — so say which it is.
      const split = text.includes(writing);
      at(
        "target-token",
        split
          ? `example contains ${writing} but kuromoji split it across tokens (${tokens.map((t) => t.text).join("|")})`
          : `example does not contain the target ${writing}`,
      );
    } else if (hit.text === writing && hit.reading && reading && !sameReading(hit.reading, reading)) {
      // Compared only on the UNINFLECTED surface — a conjugated 行った legitimately reads
      // いった, not the lemma's いく (the same rule translateParagraph uses).
      //
      // An authored example_reading SETTLES a permanent disagreement (kuromoji cannot
      // read 辛い as からい in any context). It still has to be the RIGHT answer: accepted
      // only when it matches JMdict, so it can overrule the analyzer, never the dictionary.
      if (row.exampleReading === null) {
        at(
          "target-reading",
          `example reads ${writing} as ${hit.reading}, JMdict says ${reading}` +
            ` — set example_reading to ${reading} if the sentence is right and kuromoji is wrong`,
        );
      } else if (!sameReading(row.exampleReading, reading)) {
        at(
          "reading-override",
          `example_reading ${row.exampleReading} contradicts JMdict's ${reading} for ${writing}`,
        );
      }
    } else if (row.exampleReading !== null && hit.reading !== null && sameReading(hit.reading, row.exampleReading)) {
      // The override agrees with kuromoji, so it is doing nothing — drop it rather than
      // leave a pin that hides a future regression.
      at("reading-override", `example_reading ${row.exampleReading} is redundant (kuromoji already reads it that way)`);
    }
  }

  // ── 3. no orphan content words ───────────────────────────────────────────────
  if (resolves) {
    const orphans = tokens
      .filter((t) => isContentPos(t.pos) && !isResolvable(t, resolves))
      .map((t) => t.text);
    if (orphans.length > 0) {
      at("orphan-words", `${field}: no JMdict entry for ${orphans.join(", ")} — likely mis-segmented`);
    }
  }

  return out;
}

/**
 * Every surface worth probing for one token — the SAME candidate ladder the edge
 * resolves a lookup through, not a second implementation. That matters: IPADIC
 * lexicalizes potential verbs (書ける) as entries JMdict has no headword for, so probing
 * surface and lemma alone reported perfectly natural sentences as mis-segmented. If the
 * reader can resolve a token, the gate must accept it.
 */
function probeSurfaces(t: AnalyzedToken): string[] {
  const out = new Set<string>([t.text, ...lemmaCandidates(t.text, "JA")]);
  if (t.lemma) for (const c of lemmaCandidates(t.lemma, "JA")) out.add(c);
  return [...out];
}

/** A token is resolvable when ANY of its candidate forms is a JMdict headword. */
function isResolvable(t: AnalyzedToken, resolves: (surface: string) => boolean): boolean {
  return probeSurfaces(t).some(resolves);
}

/**
 * Compare two readings as SOUND, not as script. `analyze()` hiraganizes kuromoji's
 * katakana readings for furigana, so for a katakana headword the analyzer says てれび
 * where JMdict says テレビ — same pronunciation, different script, and a naive compare
 * fails every loanword. Folding both keeps the check meaningful for the kanji headwords
 * it exists for without inventing a conflict for katakana ones.
 */
function sameReading(a: string, b: string): boolean {
  const hira = (s: string) => s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
  return hira(a) === hira(b);
}

/** Look up every entry's headword + every surface we need to probe, in two queries. */
async function loadDictionary(rows: SenseExample[], client: Client) {
  const entryIds = [...new Set(rows.map((r) => entryIdFromRef(r.dictionaryRef)).filter((x): x is string => x !== null))];
  const heads = new Map<string, Headword>();
  const { rows: headRows } = await client.query(
    `SELECT e.entry_id, h.writing, h.reading
       FROM unnest($1::text[]) AS e(entry_id),
            LATERAL jmdict_entry_headword(e.entry_id) h`,
    [entryIds],
  );
  for (const r of headRows as { entry_id: string; writing: string; reading: string | null }[]) {
    if (r.writing) heads.set(r.entry_id, { writing: r.writing, reading: r.reading });
  }

  // The orphan probe: one round-trip for the whole corpus rather than per token.
  const surfaces = new Set<string>();
  const collect = async (text: string) => {
    for (const t of await analyze(text, "JA")) {
      if (!isContentPos(t.pos)) continue;
      for (const s of probeSurfaces(t)) surfaces.add(s);
    }
  };
  for (const r of rows) {
    if (r.example) await collect(r.example);
    if (r.definitionSource) await collect(r.definitionSource);
  }
  const { rows: known } = await client.query(
    `SELECT DISTINCT s.text FROM unnest($1::text[]) AS s(text)
      WHERE EXISTS (SELECT 1 FROM jmdict_kanji k WHERE k.text = s.text)
         OR EXISTS (SELECT 1 FROM jmdict_kana  k WHERE k.text = s.text)`,
    [[...surfaces]],
  );
  const resolvable = new Set((known as { text: string }[]).map((r) => r.text));
  return { heads, resolves: (s: string) => resolvable.has(s) };
}

async function connect(): Promise<Client | null> {
  const dbUrl = process.env.DATABASE_URL ?? DEFAULT_DB_URL;
  const isLocal = dbUrl.includes("127.0.0.1") || dbUrl.includes("localhost");
  const client = new Client({
    connectionString: dbUrl,
    ssl: isLocal ? undefined : { rejectUnauthorized: false },
    connectionTimeoutMillis: 5000,
  });
  try {
    await client.connect();
    // A DB with no dictionary loaded can't answer checks 1-3 either.
    const { rows } = await client.query("SELECT count(*)::int n FROM jmdict_entries");
    if (rows[0].n === 0) {
      await client.end();
      return null;
    }
    return client;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  let text: string;
  try {
    text = readFileSync(TSV_URL, "utf8");
  } catch {
    console.log(`no corpus at ${TSV_PATH} — nothing to validate`);
    return;
  }

  await assertRealAnalyzer(); // never report a clean corpus we did not actually parse

  const { rows, issues } = parseSenseExamples(text);
  const failures: Failure[] = issues.map((i) => ({ line: i.line, check: "format", message: i.message }));

  const client = await connect();
  if (!client) {
    console.log("⚠ no dictionary reachable — running OFFLINE (offsets + format only).");
    console.log("  Set DATABASE_URL (or `supabase start`) for the target/reading/orphan checks.");
  }
  const dict = client ? await loadDictionary(rows, client) : null;

  for (const row of rows) {
    const entryId = entryIdFromRef(row.dictionaryRef);
    const head = entryId ? dict?.heads.get(entryId) ?? null : null;
    if (dict && entryId && !head) {
      failures.push({
        line: row.line,
        check: "entry",
        message: `entry ${entryId} is not in JMdict — wrong ent_seq, or the entry was renumbered`,
      });
    }
    if (row.example) {
      failures.push(...(await checkField(row, "example", row.example, head, dict?.resolves ?? null)));
    }
    if (row.definitionSource) {
      failures.push(...(await checkField(row, "definition", row.definitionSource, head, dict?.resolves ?? null)));
    }
  }
  await client?.end();

  failures.sort((a, b) => a.line - b.line);
  for (const f of failures) console.error(`✗ line ${f.line} [${f.check}] ${f.message}`);

  const mode = dict ? "full" : "offline";
  console.log(`\n${rows.length} sense(s) checked (${mode}); ${failures.length} failure(s)`);
  if (failures.length > 0) process.exit(1);
}

// Only run when invoked directly — the regression test imports checkField instead of
// running the CLI (it must not call process.exit out from under the test runner).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
