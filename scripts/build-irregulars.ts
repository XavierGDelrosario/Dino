// =========================================================
// Princeton WordNet exception lists → the English irregular-inflection maps that
// `lemmaCandidates` (edge) and `englishLemma` (reader) fall back to.
//
// WHY A BUILD SCRIPT AND NOT AN INGEST: every other reference list we load (frequency,
// proficiency, sense curation) is read by SQL or by the edge at request time, so it
// belongs in a table. Lemma candidates are computed BEFORE any query — `lemmaCandidates`
// is pure and synchronous in Deno, `englishLemma` is pure and synchronous in the browser
// — so a table would mean a round-trip per token in the one place that has none. At
// ~130 KB the whole list is smaller than one page of the dictionary it saves us querying,
// so it ships as generated code in both runtimes instead.
//
// ONE FILE, TWO POLICIES (docs/TODO.md). The edge takes EVERYTHING: it hands every
// candidate to the dictionary, which discards the bogus ones, so an over-generated
// candidate costs nothing. The reader has no verifier — `keyOf` picks exactly one key —
// so a WRONG lemma silently resolves the word to something else. Its map is therefore
// filtered to entries that cannot be wrong:
//   1. single-token only         (multiword exceptions never match a reader token)
//   2. exactly ONE base          (axes → ax|axis is a guess without a verifier)
//   3. the surface is NOT itself a WordNet lemma of any POS — this is the mechanical
//      form of lemmaEn.ts's hand rule "the surface must not itself be a common word",
//      and it reproduces 21 of that file's 23 curated exclusions. The remaining two
//      (met, meant) stay hand-listed in EN_IRREGULAR_EXCLUDED, which lemmaEn.ts applies
//      on top of this map — so the curated list still wins.
//   4. base ≠ surface, surface ≥ 3 chars (englishLemma ignores shorter tokens anyway)
//   5. the surface is not ALSO a regular -s/-es form of some other word. WordNet's
//      noun list knows `lives` only as the plural of life, so without this the reader
//      answers "life" for «he lives in Tokyo» — the exact silent-wrong-lemma failure
//      lemmaEn.ts's header warns about. Measured on 119 en.wikinews articles: every
//      such surface resolved to NOTHING beforehand (englishLemma's -es guard already
//      refused them), so holding them back costs no working lemma. ~57 entries.
//
// The hand-written maps in both runtimes STAY. WordNet's lists are exceptions to ITS
// morphology rules, not a lemma dictionary: `does`, `women` and `people` are absent
// entirely and `is` is listed against itself. The generated map is a FALLBACK consulted
// after the curated one.
//
// SOURCE: WordNet 3.0, `dict/{verb,noun,adj,adv}.exc` + `dict/index.*` for the lemma set.
// Princeton licence (BSD-style) — already attributed for the wnjpn ingest.
//   curl -L -O https://wordnetcode.princeton.edu/3.0/WordNet-3.0.tar.gz
//   tar -xzf WordNet-3.0.tar.gz
//   npm run build:irregulars -- ./WordNet-3.0/dict
// =========================================================
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TSV_OUT = join(ROOT, "data/irregulars/en.tsv");
const READER_OUT = join(ROOT, "src/services/language/irregularsEn.generated.ts");
const EDGE_OUT = join(ROOT, "supabase/functions/translate/_irregulars.generated.ts");

const EXC_FILES = [
  ["verb.exc", "v"],
  ["noun.exc", "n"],
  ["adj.exc", "a"],
  ["adv.exc", "r"],
] as const;
const INDEX_FILES = ["index.noun", "index.verb", "index.adj", "index.adv"];

interface Entry {
  surface: string;
  bases: string[];
  pos: string[];
  /** Passes the reader policy — safe without a verifier. */
  reader: boolean;
}

/** Every lemma WordNet knows, any POS. A surface in here is a word in its own right. */
function readLemmas(dict: string): Set<string> {
  const out = new Set<string>();
  for (const file of INDEX_FILES) {
    for (const line of readFileSync(join(dict, file), "utf8").split("\n")) {
      if (line.startsWith("  ") || !line) continue; // the licence header is space-indented
      out.add(line.slice(0, line.indexOf(" ")));
    }
  }
  return out;
}

/** `<inflected> <base> [<base> …]`, one per line, underscores for multiword. */
function readExceptions(dict: string): Map<string, Entry> {
  const bySurface = new Map<string, Entry>();
  for (const [file, pos] of EXC_FILES) {
    for (const line of readFileSync(join(dict, file), "utf8").split("\n")) {
      const parts = line.trim().split(/\s+/).filter(Boolean);
      if (parts.length < 2) continue;
      const [surface, ...bases] = parts;
      const entry = bySurface.get(surface) ?? { surface, bases: [], pos: [], reader: false };
      for (const b of bases) if (!entry.bases.includes(b)) entry.bases.push(b);
      if (!entry.pos.includes(pos)) entry.pos.push(pos);
      bySurface.set(surface, entry);
    }
  }
  return bySurface;
}

/** Rule 5: could this surface just as well be someone else's regular -s/-es form?
 *  `lives` → life, but strip the s and `live` is a verb; `shelves` → shelf, but
 *  `shelve` is one too. WordNet lists only the noun, so the map would answer with it
 *  silently. `wolves` is safe by the same test — there is no verb `wolve`. */
function alsoARegularPlural(surface: string, base: string, lemmas: Set<string>): boolean {
  if (!surface.endsWith("s")) return false;
  const stems = [surface.slice(0, -1)];
  if (surface.endsWith("es")) stems.push(surface.slice(0, -2));
  return stems.some((stem) => stem.length >= 3 && stem !== base && lemmas.has(stem));
}

function applyReaderPolicy(entries: Map<string, Entry>, lemmas: Set<string>): void {
  for (const e of entries.values()) {
    const singleToken = !e.surface.includes("_") && e.bases.every((b) => !b.includes("_"));
    e.reader =
      singleToken &&
      e.bases.length === 1 &&
      e.bases[0] !== e.surface &&
      e.surface.length >= 3 &&
      !lemmas.has(e.surface) &&
      !alsoARegularPlural(e.surface, e.bases[0], lemmas);
  }
}

const BANNER = (script: string) =>
  `// GENERATED by scripts/${script} from Princeton WordNet 3.0 — DO NOT EDIT BY HAND.\n` +
  `// Regenerate: npm run build:irregulars -- ./WordNet-3.0/dict\n`;

function writeTsv(entries: Entry[]): void {
  const lines = [
    "# Princeton WordNet 3.0 irregular inflections — surface → base form(s).",
    "# GENERATED by scripts/build-irregulars.ts. Columns:",
    "#   surface <TAB> base[,base] <TAB> pos[,pos] (v|n|a|r) <TAB> reader (1 = safe",
    "#   without a verifier, so englishLemma may use it; 0 = edge-only, see the script)",
    ...entries.map((e) => `${e.surface}\t${e.bases.join(",")}\t${e.pos.join(",")}\t${e.reader ? 1 : 0}`),
  ];
  mkdirSync(dirname(TSV_OUT), { recursive: true });
  writeFileSync(TSV_OUT, `${lines.join("\n")}\n`, "utf8");
}

/** A quoted key only where the identifier form would be invalid (hyphens, digits). */
const key = (s: string) => (/^[a-z][a-z]*$/.test(s) ? s : JSON.stringify(s));

function writeReaderModule(entries: Entry[]): void {
  const rows = entries.filter((e) => e.reader);
  const body = rows.map((e) => `  ${key(e.surface)}: ${JSON.stringify(e.bases[0])},`).join("\n");
  writeFileSync(
    READER_OUT,
    `${BANNER("build-irregulars.ts")}//
// The READER half: entries that cannot be wrong without a verifier (single token, one
// base, and the surface is not itself a WordNet lemma). lemmaEn.ts consults this AFTER
// its curated map and still applies EN_IRREGULAR_EXCLUDED on top.

/** Irregular surface → its one dictionary form. ${rows.length} entries. */
export const EN_IRREGULARS_WORDNET: Readonly<Record<string, string>> = {
${body}
};
`,
    "utf8",
  );
}

function writeEdgeModule(entries: Entry[]): void {
  const rows = entries.filter((e) => !e.surface.includes("_") && e.bases.every((b) => !b.includes("_")));
  const body = rows
    .map((e) => `  ${key(e.surface)}: ${JSON.stringify(e.bases)},`)
    .join("\n");
  writeFileSync(
    EDGE_OUT,
    `${BANNER("build-irregulars.ts")}//
// The EDGE half: every single-token exception, ambiguous ones included. The dictionary
// verifies each candidate, so over-generating is free — and a surface that is also a
// valid lemma (saw, rose, left) is harmless because lemmaCandidates tries the SURFACE
// first. Multiword entries are dropped: no lookup key ever contains an underscore.

/** Irregular surface → every base WordNet lists for it. ${rows.length} entries. */
export const EN_IRREGULARS_WORDNET: Record<string, string[]> = {
${body}
};
`,
    "utf8",
  );
}

function main(): void {
  const dict = process.argv[2];
  if (!dict) {
    console.error("usage: npm run build:irregulars -- <path to WordNet-3.0/dict>");
    process.exit(1);
  }
  const lemmas = readLemmas(dict);
  const entries = readExceptions(dict);
  applyReaderPolicy(entries, lemmas);

  const all = [...entries.values()].sort((a, b) => (a.surface < b.surface ? -1 : 1));
  writeTsv(all);
  writeReaderModule(all);
  writeEdgeModule(all);

  const reader = all.filter((e) => e.reader).length;
  const multiword = all.filter((e) => e.surface.includes("_")).length;
  const ambiguous = all.filter((e) => e.bases.length > 1).length;
  console.log(`WordNet lemmas (any POS): ${lemmas.size}`);
  console.log(`exceptions: ${all.length} (${multiword} multiword, ${ambiguous} with >1 base)`);
  console.log(`  edge map:   ${all.length - multiword} entries`);
  console.log(`  reader map: ${reader} entries (${all.length - multiword - reader} held back by the reader policy)`);
  console.log(`wrote ${TSV_OUT}\n      ${READER_OUT}\n      ${EDGE_OUT}`);
}

main();
