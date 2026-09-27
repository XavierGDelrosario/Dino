// =========================================================
// Compute and STORE the level estimate for every unranked dictionary writing — the
// one-time calculation behind migration 20260779. The rule is scripts/lib/levelEstimate.ts.
//
// In one transaction:
//   1. fit the rule on the curated words (the shown headword of each levelled entry —
//      its frequency, word shape and teaching-list membership, and its JLPT band);
//   2. apply it to every jmdict_kanji / jmdict_kana writing that has NO curated band and
//      is levelable vocabulary (not grammar / an affix / an interjection / a JMdict name —
//      not_leveled_vocab, judged by the entry's primary sense), UPDATE only what changes;
//   3. re-derive words.estimated_band for the JA→EN cache with words_level_estimate() —
//      the trigger does this for rows written from now on; this catches the ones already
//      cached. A curated band always wins: those rows get NULL.
//
// Nothing is inserted or deleted and no identity changes. Idempotent: a second run finds
// nothing to change. Re-run after any re-ingest of the dictionary, frequency, proficiency
// or teaching-list data.
//
// USAGE:
//   npm run apply:level-estimates -- --dry-run      # counts + a sample, writes nothing
//   npm run apply:level-estimates                   # local (127.0.0.1:54322) by default
//   DATABASE_URL='postgresql://postgres.<ref>:<pwd>@<pooler-host>:5432/postgres' \
//     npm run apply:level-estimates                 # a hosted project (SSL auto-enabled)
// =========================================================
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { fitLevelEstimate, type LevelledWord } from "./lib/levelEstimate";

const DEFAULT_DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const TEACHING_VOCAB = new URL("../data/teaching_vocab/ja.tsv", import.meta.url);

interface WritingRow {
  id: string;
  text: string;
  frequency: number | null;
  proficiency_band: number | null;
  estimated_band: number | null;
  levelable: boolean;
}

function loadTeachingVocab(): Set<string> {
  const lines = readFileSync(TEACHING_VOCAB, "utf8").split("\n");
  return new Set(lines.filter((l) => l && !l.startsWith("#")).map((l) => l.normalize("NFC")));
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const teaching = loadTeachingVocab();
  if (teaching.size === 0) {
    console.error("empty data/teaching_vocab/ja.tsv — run scripts/build-teaching-vocab.py first");
    process.exit(1);
  }

  const dbUrl = process.env.DATABASE_URL ?? DEFAULT_DB_URL;
  const isLocal = dbUrl.includes("127.0.0.1") || dbUrl.includes("localhost");
  const client = new Client({ connectionString: dbUrl, ssl: isLocal ? undefined : { rejectUnauthorized: false } });
  await client.connect();
  try {
    // 1. Fit on the curated headwords.
    const training = (
      await client.query<{ writing: string; frequency: number; band: number }>(
        `SELECT writing, frequency, proficiency_band AS band
           FROM jmdict_entry_headword_mv
          WHERE proficiency_band BETWEEN 1 AND 5 AND frequency IS NOT NULL
            AND NOT not_leveled_vocab(part_of_speech, entry_id)`,
      )
    ).rows;
    if (training.length === 0) {
      console.error("no curated words to learn from — ingest JMdict + proficiency first");
      process.exit(1);
    }
    const rule = fitLevelEstimate(
      training.map<LevelledWord>((t) => ({ ...t, onTeachingList: teaching.has(t.writing) })),
    );

    // 2. Every writing, with whether its entry is levelable vocabulary at all.
    const writings = (table: string) =>
      client.query<WritingRow>(
        `SELECT t.id::text, t.text, t.frequency, t.proficiency_band, t.estimated_band,
                NOT not_leveled_vocab(h.part_of_speech, t.entry_id) AS levelable
           FROM ${table} t JOIN jmdict_entry_headword_mv h USING (entry_id)`,
      );
    // A writing with no letter at all (○, ※) is a symbol, not vocabulary.
    const estimate = (r: WritingRow) =>
      r.proficiency_band == null && r.levelable && /\p{L}/u.test(r.text)
        ? rule(r.text, r.frequency, teaching.has(r.text))
        : null;

    type Change = { id: string; text: string; was: number | null; band: number | null };
    const changes: Record<string, Change[]> = {};
    for (const table of ["jmdict_kanji", "jmdict_kana"]) {
      const rows = (await writings(table)).rows;
      const next = rows.map((r) => ({ id: r.id, text: r.text, was: r.estimated_band, band: estimate(r) }));
      changes[table] = next.filter((r) => r.band !== r.was);
      const dist = [3, 4, 5].map((b) => `N${6 - b} ${next.filter((r) => r.band === b).length}`).join(", ");
      console.log(`${table}: ${rows.length} writings → estimated ${dist}; ${changes[table].length} change`);
    }
    for (const r of changes.jmdict_kanji.slice(0, 10)) {
      console.log(`  ${r.text} ${r.was ?? "—"} → ${r.band ?? "—"}`);
    }
    if (dryRun) {
      console.log("--dry-run: nothing written");
      return;
    }

    await client.query("BEGIN");
    for (const [table, rows] of Object.entries(changes)) {
      if (rows.length === 0) continue;
      await client.query(
        `UPDATE ${table} t SET estimated_band = c.band
           FROM unnest($1::bigint[], $2::smallint[]) AS c(id, band)
          WHERE t.id = c.id`,
        [rows.map((r) => r.id), rows.map((r) => r.band)],
      );
    }
    // 3. The cache. The trigger keeps rows written from now on current; this re-derives
    //    the ones already cached (setting estimated_band alone does not fire it).
    const words = await client.query(
      `UPDATE words w
          SET estimated_band = n.band
         FROM (SELECT word_id,
                      CASE WHEN proficiency_band IS NULL AND jmdict_entry_id IS NOT NULL
                           THEN words_level_estimate(jmdict_entry_id, input) END AS band
                 FROM words WHERE source_lang = 'JA') n
        WHERE n.word_id = w.word_id AND w.estimated_band IS DISTINCT FROM n.band`,
    );
    await client.query("COMMIT");
    console.log(`words: ${words.rowCount} cached JA→EN rows re-estimated`);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
