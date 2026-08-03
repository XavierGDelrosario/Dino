// =========================================================
// Load data/sense_examples/ja.tsv → the server-only `sense_curation` table
// (per-sense curation keyed on dictionary_ref; see migration 20260752), then push the
// values onto any `words` rows already cached for those senses.
//
// The FILE is the source of truth — this direction's rows are deleted and reloaded from
// it, so a sentence dropped from the corpus disappears everywhere. DELETE scoped to the
// language pair rather than TRUNCATE: en.tsv's rows must survive a ja.tsv ingest, and
// TRUNCATE takes an ACCESS EXCLUSIVE lock that a live edge lookup would block on. Authored data, versioned in
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
//     [<TAB> example_reading [<TAB> sense_rank]]
// A trailing field may be empty (= NULL). Fields must not contain tabs or newlines.
//
// USAGE:
//   npx tsx scripts/validate-sense-examples.ts   # the kuromoji gate — run this FIRST
//   npm run ingest:sense-examples                # local (127.0.0.1:54322) by default
//   DATABASE_URL='postgresql://postgres:<pwd>@db.<ref>.supabase.co:5432/postgres' \
//     npm run ingest:sense-examples              # a hosted project (SSL auto-enabled)
// =========================================================
import { Client } from "pg";
import { readSenseExamples, TSV_PATH, SOURCE_LANG, TARGET_LANG, type SenseExample } from "./lib/senseExamples";

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
    await client.query("DELETE FROM sense_curation WHERE source_lang = $1 AND target_lang = $2", [SOURCE_LANG, TARGET_LANG]);
    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH);
      await client.query(
        `INSERT INTO sense_curation
           (dictionary_ref, source_lang, target_lang, example, example_gloss,
            definition_source, example_reading, sense_rank)
         SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[],
                              $6::text[], $7::text[], $8::int[])`,
        [
          chunk.map((r) => r.dictionaryRef),
          chunk.map(() => SOURCE_LANG),
          chunk.map(() => TARGET_LANG),
          chunk.map((r) => r.example),
          chunk.map((r) => r.exampleGloss),
          chunk.map((r) => r.definitionSource),
          chunk.map((r) => r.exampleReading),
          chunk.map((r) => r.senseRank),
        ],
      );
    }

    // Push onto the cache. JA→EN ONLY: for EN→JA rows `jmdict_sense_pos` is a match
    // rank across entries, not a sense index (20260742), so joining on it there would
    // attach another sense's sentence. See the migration header.
    const { rowCount: healed } = await client.query(
      `UPDATE words w
          SET example           = c.example,
              example_gloss     = c.example_gloss,
              definition_source = c.definition_source,
              example_reading   = c.example_reading,
              -- Curated order where given, else the default: JMdict's own sense position
              -- for JA→EN, the ranker's position for EN→JA. Never NULL — reads sort on it.
              sense_rank        = COALESCE(c.sense_rank, w.jmdict_sense_pos)
         FROM sense_curation c
        WHERE lower(w.dictionary_ref) = c.dictionary_ref
          AND w.source_lang = c.source_lang AND w.target_lang = c.target_lang
          AND (w.example           IS DISTINCT FROM c.example
            OR w.example_gloss     IS DISTINCT FROM c.example_gloss
            OR w.definition_source IS DISTINCT FROM c.definition_source
            OR w.example_reading   IS DISTINCT FROM c.example_reading
            OR w.sense_rank        IS DISTINCT FROM COALESCE(c.sense_rank, w.jmdict_sense_pos))`,
    );

    // A sentence REMOVED from the corpus has to leave the cache too, or the deletion
    // never reaches anyone — the row above only touches senses still in the file.
    const { rowCount: cleared } = await client.query(
      `UPDATE words w
          SET example = NULL, example_gloss = NULL, definition_source = NULL,
              example_reading = NULL,
              -- Back to the default order, NOT to NULL — a withdrawn curation restores
              -- the dictionary's ordering, it does not erase it.
              sense_rank = w.jmdict_sense_pos
        WHERE (w.example IS NOT NULL OR w.example_gloss IS NOT NULL
               OR w.definition_source IS NOT NULL OR w.example_reading IS NOT NULL
               OR w.sense_rank IS DISTINCT FROM w.jmdict_sense_pos)
          AND NOT EXISTS (
            SELECT 1 FROM sense_curation c
             WHERE c.dictionary_ref = lower(w.dictionary_ref)
               AND c.source_lang = w.source_lang AND c.target_lang = w.target_lang)`,
    );

    await client.query("COMMIT");

    const { rows: [counts] } = await client.query(
      `SELECT (SELECT count(*)::int FROM sense_curation) AS corpus,
              (SELECT count(*)::int FROM words WHERE example IS NOT NULL) AS cached`,
    );
    console.log(`sense_curation: ${counts.corpus} curated rows`);
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
