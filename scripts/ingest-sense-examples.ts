// =========================================================
// Load data/sense_examples/ja.tsv → the server-only `jmdict_sense_example` table
// (per-sense example sentence + JA definition; see migration 20260750), then push the
// values onto any `words` rows already cached for those senses.
//
// The FILE is the source of truth — the table is truncate-and-reloaded from it, so a
// sentence deleted from the corpus disappears everywhere. Authored data, versioned in
// git; this is one-time / regeneration tooling, never a runtime dependency.
//
// ‼️ THE BACKFILL IS NOT OPTIONAL. `words` is a lazy cache and the projection-version
// bump only heals a row when somebody looks that word up again — but Lists and the
// article word list read a SAVED word's attributes straight off `words` through a
// PostgREST join, never touching the edge function. Without the backfill the words a
// user has already saved (exactly the ones they study) would be the last to ever show
// an example. Same lesson as 20260740, which had to backfill proficiency_band for the
// identical reason.
//
// FORMAT (tab-separated, one sense per line, '#' comments and blank lines skipped):
//   entry_id <TAB> sense_pos <TAB> example <TAB> example_gloss <TAB> definition_ja
// A trailing field may be empty (= NULL). Fields must not contain tabs or newlines.
//
// USAGE:
//   npx tsx scripts/validate-sense-examples.ts   # the kuromoji gate — run this FIRST
//   npm run ingest:sense-examples                # local (127.0.0.1:54322) by default
//   DATABASE_URL='postgresql://postgres:<pwd>@db.<ref>.supabase.co:5432/postgres' \
//     npm run ingest:sense-examples              # a hosted project (SSL auto-enabled)
// =========================================================
import { Client } from "pg";
import { readSenseExamples, TSV_PATH, type SenseExample } from "./lib/senseExamples";

const DEFAULT_DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const BATCH = 5000;

async function main(): Promise<void> {
  const rows: SenseExample[] = readSenseExamples();
  console.log(`loaded ${rows.length} senses from ${TSV_PATH}`);
  if (rows.length === 0) {
    console.error("nothing to ingest — refusing to truncate a populated table for an empty file");
    process.exit(1);
  }

  const dbUrl = process.env.DATABASE_URL ?? DEFAULT_DB_URL;
  const isLocal = dbUrl.includes("127.0.0.1") || dbUrl.includes("localhost");
  const client = new Client({
    connectionString: dbUrl,
    ssl: isLocal ? undefined : { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("TRUNCATE jmdict_sense_example");
    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH);
      await client.query(
        `INSERT INTO jmdict_sense_example
           (jmdict_entry_id, jmdict_sense_pos, example, example_gloss, definition_ja)
         SELECT * FROM unnest($1::text[], $2::int[], $3::text[], $4::text[], $5::text[])`,
        [
          chunk.map((r) => r.entryId),
          chunk.map((r) => r.sensePos),
          chunk.map((r) => r.example),
          chunk.map((r) => r.exampleGloss),
          chunk.map((r) => r.definitionJa),
        ],
      );
    }

    // Push onto the cache. JA→EN ONLY: for EN→JA rows `jmdict_sense_pos` is a match
    // rank across entries, not a sense index (20260742), so joining on it there would
    // attach another sense's sentence. See the migration header.
    const { rowCount: healed } = await client.query(
      `UPDATE words w
          SET example       = e.example,
              example_gloss = e.example_gloss,
              definition_ja = e.definition_ja
         FROM jmdict_sense_example e
        WHERE w.jmdict_entry_id  = e.jmdict_entry_id
          AND w.jmdict_sense_pos = e.jmdict_sense_pos
          AND w.source_lang = 'JA' AND w.target_lang = 'EN'
          AND (w.example       IS DISTINCT FROM e.example
            OR w.example_gloss IS DISTINCT FROM e.example_gloss
            OR w.definition_ja IS DISTINCT FROM e.definition_ja)`,
    );

    // A sentence REMOVED from the corpus has to leave the cache too, or the deletion
    // never reaches anyone — the row above only touches senses still in the file.
    const { rowCount: cleared } = await client.query(
      `UPDATE words w
          SET example = NULL, example_gloss = NULL, definition_ja = NULL
        WHERE (w.example IS NOT NULL OR w.example_gloss IS NOT NULL OR w.definition_ja IS NOT NULL)
          AND NOT EXISTS (
            SELECT 1 FROM jmdict_sense_example e
             WHERE e.jmdict_entry_id  = w.jmdict_entry_id
               AND e.jmdict_sense_pos = w.jmdict_sense_pos)`,
    );

    await client.query("COMMIT");

    const { rows: [counts] } = await client.query(
      `SELECT (SELECT count(*)::int FROM jmdict_sense_example) AS corpus,
              (SELECT count(*)::int FROM words WHERE example IS NOT NULL) AS cached`,
    );
    console.log(`jmdict_sense_example: ${counts.corpus} senses`);
    console.log(`words cache: ${healed} row(s) updated, ${cleared} cleared → ${counts.cached} now carry an example`);
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
