// =========================================================
// Fill wordnet_senses_en.sense_rank from Princeton WordNet 3.0 `index.sense`.
//
// WHY. The Japanese WordNet (wnjpn) ships NO sense ranks, so the ingest left
// sense_rank = 0 on every one of the 206,941 English sense rows. Every EN→JA ranking
// step that reserves a slot for "WordNet's own sense order" (MIN(sense_rank) in
// 20260716 / 20260747) was therefore inert, and the primary Japanese meaning of a
// polysemous English word was chosen by headline frequency alone. Princeton's
// `index.sense` carries the sense NUMBER per lemma (1 = the most frequent sense, by
// SemCor tag counts) and its ids line up with wnjpn's: `08641944 n` here is
// `08641944-n` there. This script writes that number into sense_rank.
//
// Lower = more frequent, exactly the convention the SQL already orders on. A row
// Princeton does not list is set to NULL — the column's documented "unranked" — rather
// than left at 0, which would sort AHEAD of every real rank; MIN() skips NULLs.
//
// Idempotent and safe to re-run; run it after any wordnet_* re-ingest (the ingest
// truncates the table). Same DATABASE_URL convention as the other ingests: on a hosted
// project use the IPv4 session pooler (see memory / docs).
//   curl -L -O https://wordnetcode.princeton.edu/3.0/WordNet-3.0.tar.gz && tar -xzf WordNet-3.0.tar.gz
//   DATABASE_URL=... npm run apply:wordnet-ranks -- ./WordNet-3.0/dict/index.sense
// =========================================================
import { readFileSync } from "node:fs";
import { Client } from "pg";

const DEFAULT_DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const file = process.argv[2];
if (!file) {
  console.error("usage: npm run apply:wordnet-ranks -- <path to WordNet-3.0/dict/index.sense>");
  process.exit(1);
}

/** ss_type digit → the POS letter in wnjpn synset ids. 5 (adjective satellite) is
 *  stored as "a" by wnjpn, but "s" is tried too in case an edition keeps it. */
const POS: Record<string, string[]> = { "1": ["n"], "2": ["v"], "3": ["a"], "4": ["r"], "5": ["a", "s"] };

interface Row { lemma: string; synset: string; rank: number }
const rows: Row[] = [];
for (const line of readFileSync(file, "utf8").split("\n")) {
  if (!line) continue;
  // "<lemma>%<ss_type>:<lex_filenum>:<lex_id>:<head>:<head_id> <offset> <sense_number> <tag_cnt>"
  const [key, offset, senseNumber] = line.split(" ");
  const pct = key.indexOf("%");
  if (pct < 0 || !offset || !senseNumber) continue;
  const lemma = key.slice(0, pct).toLowerCase();
  const ssType = key.charAt(pct + 1);
  for (const pos of POS[ssType] ?? []) rows.push({ lemma, synset: `${offset}-${pos}`, rank: Number(senseNumber) });
}
console.log(`index.sense: ${rows.length} (lemma, synset) ranks read`);

const client = new Client({ connectionString: process.env.DATABASE_URL ?? DEFAULT_DB_URL });
await client.connect();
try {
  await client.query("BEGIN");
  await client.query("CREATE TEMP TABLE pwn_rank (lemma TEXT, synset_id TEXT, rank INT) ON COMMIT DROP");
  const CHUNK = 5000;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const values: unknown[] = [];
    const tuples = slice.map((r, k) => {
      values.push(r.lemma, r.synset, r.rank);
      const b = k * 3;
      return `($${b + 1}, $${b + 2}, $${b + 3})`;
    });
    await client.query(`INSERT INTO pwn_rank VALUES ${tuples.join(",")}`, values);
  }
  // wnjpn lemmas may carry spaces where Princeton has underscores; normalise both.
  const upd = await client.query(`
    UPDATE wordnet_senses_en se
       SET sense_rank = p.rank
      FROM pwn_rank p
     WHERE p.synset_id = se.synset_id
       AND p.lemma = replace(lower(se.lemma), ' ', '_')`);
  const nul = await client.query(`
    UPDATE wordnet_senses_en se
       SET sense_rank = NULL
     WHERE sense_rank = 0`);
  const stats = await client.query(`
    SELECT count(*) AS total,
           count(*) FILTER (WHERE sense_rank IS NOT NULL) AS ranked,
           count(*) FILTER (WHERE sense_rank IS NULL) AS unranked
      FROM wordnet_senses_en`);
  await client.query("COMMIT");
  console.log(`ranked ${upd.rowCount} rows · ${nul.rowCount} left unranked (NULL) · now`, stats.rows[0]);
} catch (e) {
  await client.query("ROLLBACK");
  throw e;
} finally {
  await client.end();
}
