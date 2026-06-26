// =========================================================
// Japanese WordNet ingest loader (one-time, server-side ETL).
//
// Loads the bond-lab Japanese WordNet into the normalized wordnet_* tables (see
// supabase/migrations/20260703_wordnet.sql). The translate edge function then
// queries them via wordnet_en_ja_lookup() to drive a SEMANTIC EN->JA lookup
// (English lemma -> synsets -> Japanese lemmas), resolved through JMdict for
// readings/frequency/POS.
//
// Two inputs, both from https://bond-lab.github.io/wnja/eng/downloads.html:
//   * wnjpn.db       — the SQLite release. We read the English side (word/sense,
//                      with the Princeton sense `rank`) + synset defs from it.
//   * wnjpn-ok.tab   — the curated HIGH-CONFIDENCE synset->Japanese-word mapping
//                      (synset_id \t lemma \t confidence). Using the "-ok" subset
//                      (not "-all") keeps the ~5%-error low-confidence tail out,
//                      directly serving the EN->JA quality goal.
//
// Reads the SQLite file with Node's built-in `node:sqlite` (Node >= 22) — no
// native dependency. Writes ONLY the wordnet_* tables; NEVER touches words /
// user_words / lists / jmdict_*. Re-running is safe: truncate + reload in one txn.
//
// Japanese WordNet 1.1 — BSD-like (JA data) + Princeton WordNet license (EN side);
// attribution required (see ATTRIBUTION.md).
//
// USAGE:
//   1. Download + gunzip wnjpn.db.gz and wnjpn-ok.tab.gz.
//   2. Point at your local Supabase Postgres (default below) or set DATABASE_URL:
//        npm run ingest:wordnet -- ./wnjpn.db ./wnjpn-ok.tab
//   (The JMdict ingest must have run first — wordnet_en_ja_lookup resolves the
//   Japanese lemmas against the jmdict_* tables; a lemma JMdict lacks is dropped.)
// =========================================================
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Client } from "pg";

const DEFAULT_DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const nfc = (s: string) => s.normalize("NFC");

/** Bulk multi-row INSERT, chunked to stay under Postgres' ~65535 param cap.
 *  (Same helper shape as scripts/ingest-jmdict.ts.) */
async function bulkInsert(
  client: Client,
  table: string,
  columns: string[],
  rows: unknown[][],
): Promise<void> {
  if (rows.length === 0) return;
  const cols = columns.length;
  const batchSize = Math.max(1, Math.floor(60000 / cols));
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const params: unknown[] = [];
    const tuples = batch.map((row, r) => {
      const ph = row.map((_, c) => `$${r * cols + c + 1}`);
      params.push(...row);
      return `(${ph.join(",")})`;
    });
    await client.query(
      `INSERT INTO ${table} (${columns.join(",")}) VALUES ${tuples.join(",")}`,
      params,
    );
  }
}

interface SynsetRow { synset: string; pos: string; def: string | null }
interface SenseRow { lemma: string; synset: string; rank: number | null }

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const dbFile = args[0];
  const okFile = args[1];
  if (!dbFile || !okFile) {
    console.error(
      "Usage: npm run ingest:wordnet -- <path-to-wnjpn.db> <path-to-wnjpn-ok.tab>",
    );
    process.exit(1);
  }
  const dbUrl = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

  // --- 1. Read the SQLite release --------------------------------------------
  console.log(`Reading SQLite ${dbFile} ...`);
  const sqlite = new DatabaseSync(dbFile, { readOnly: true });

  // Synsets + their English definition (first def per synset). All synsets are
  // tiny (~57k) and both wordnet_senses_en and wordnet_words_ja FK to them, so we
  // load the full set and track which ids exist (to drop dangling ok.tab rows).
  const synsetRows = sqlite
    .prepare(
      `SELECT s.synset AS synset, s.pos AS pos,
              (SELECT d.def FROM synset_def d
                WHERE d.synset = s.synset AND d.lang = 'eng'
                ORDER BY d.sid LIMIT 1) AS def
         FROM synset s`,
    )
    .all() as unknown as SynsetRow[];
  const knownSynsets = new Set(synsetRows.map((r) => r.synset));
  console.log(`  ${synsetRows.length} synsets`);

  // English lemma -> synset, with the Princeton sense rank (lower = more frequent).
  const senseRows = sqlite
    .prepare(
      `SELECT w.lemma AS lemma, se.synset AS synset, se.rank AS rank
         FROM word w
         JOIN sense se ON se.wordid = w.wordid
        WHERE w.lang = 'eng'`,
    )
    .all() as unknown as SenseRow[];
  console.log(`  ${senseRows.length} English senses`);
  sqlite.close();

  // --- 2. Read the high-confidence JA mapping (wnjpn-ok.tab) ------------------
  // Lines: "<synset_id>\t<japanese lemma>\t<confidence>". Skip rows whose synset
  // isn't in the db (defensive; the two releases should agree).
  const okRaw = readFileSync(okFile, "utf8");
  const jaRows: unknown[][] = [];
  let droppedUnknown = 0;
  for (const line of okRaw.split("\n")) {
    if (!line) continue;
    const [synset, lemma, confidence] = line.split("\t");
    if (!synset || !lemma) continue;
    if (!knownSynsets.has(synset)) { droppedUnknown++; continue; }
    jaRows.push([synset, nfc(lemma), confidence ?? null]);
  }
  console.log(
    `  ${jaRows.length} Japanese mappings (wnjpn-ok)` +
      (droppedUnknown ? ` — dropped ${droppedUnknown} with unknown synset` : ""),
  );

  // Flatten the SQLite rows into insert tuples (lemma lowercased for EN matching).
  const synsets: unknown[][] = synsetRows.map((r) => [r.synset, r.pos, r.def ?? null]);
  const senses: unknown[][] = senseRows.map((r) => [
    r.lemma.trim().toLowerCase(),
    r.synset,
    r.rank ?? null,
  ]);

  // --- 3. Load into Postgres (truncate + reload in one transaction) ----------
  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  const started = Date.now();
  try {
    await client.query("BEGIN");
    console.log("Truncating wordnet_* tables ...");
    await client.query(
      "TRUNCATE wordnet_words_ja, wordnet_senses_en, wordnet_synsets RESTART IDENTITY CASCADE",
    );

    console.log(`Inserting ${synsets.length} synsets ...`);
    await bulkInsert(client, "wordnet_synsets", ["synset_id", "pos", "definition_en"], synsets);

    console.log(`Inserting ${senses.length} English senses ...`);
    await bulkInsert(client, "wordnet_senses_en", ["lemma", "synset_id", "sense_rank"], senses);

    console.log(`Inserting ${jaRows.length} Japanese mappings ...`);
    await bulkInsert(client, "wordnet_words_ja", ["synset_id", "lemma", "confidence"], jaRows);

    await client.query("COMMIT");
    console.log(
      `Done in ${((Date.now() - started) / 1000).toFixed(1)}s — ` +
        `${synsets.length} synsets, ${senses.length} EN senses, ${jaRows.length} JA mappings.`,
    );
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
