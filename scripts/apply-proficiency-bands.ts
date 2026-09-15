// =========================================================
// Re-level an ALREADY-LOADED JMdict from data/proficiency/ja.tsv, in place — no
// re-ingest. The ingest applies the same rule when it loads; this exists because a full
// re-ingest TRUNCATEs the jmdict_* tables a live edge function is reading.
//
// What it does, in one transaction:
//   1. recompute proficiency_band for every jmdict_kanji / jmdict_kana row with the rule
//      in scripts/lib/proficiency.ts, and UPDATE only the rows whose band changes;
//   2. re-derive words.proficiency_band for the JA→EN cache rows of the entries that
//      moved, with jmdict_lookup's own expression (the shown writing's band, else the
//      entry's kanji band). ‼️ Not optional: Lists reads a saved word's band straight off
//      `words` and never re-projects it, so without this the words users have already
//      saved — the ones they study — would keep the wrong level forever. EN→JA rows are
//      not touched: their band is CEFR, stamped by the edge from english_proficiency.
// then REFRESH MATERIALIZED VIEW CONCURRENTLY jmdict_entry_headword_mv (the Learn pool
// and the EN→JA headword read it), which does not block readers.
//
// Nothing is inserted or deleted and no identity changes, so no user_words reference
// can dangle. Idempotent: a second run finds nothing to change.
//
// AFTERWARDS re-run `npm run build:leveling -- JA` — the band anchors are measured from
// these bands.
//
// USAGE:
//   npm run apply:proficiency -- --dry-run     # counts + a sample, writes nothing
//   npm run apply:proficiency -- --dry-run --list   # …and every changed writing
//   npm run apply:proficiency                  # local (127.0.0.1:54322) by default
//   DATABASE_URL='postgresql://postgres:<pwd>@db.<ref>.supabase.co:5432/postgres' \
//     npm run apply:proficiency                # a hosted project (SSL auto-enabled)
// =========================================================
import { Client } from "pg";
import { bandForWriting, loadProficiency } from "./lib/proficiency";

const DEFAULT_DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

interface WritingRow {
  id: string;
  entry_id: string;
  text: string;
  proficiency_band: number | null;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const listAll = process.argv.includes("--list");
  const table = loadProficiency("ja");
  if (table.size === 0) {
    console.error("empty proficiency table — refusing to strip every band from the dictionary");
    process.exit(1);
  }

  const dbUrl = process.env.DATABASE_URL ?? DEFAULT_DB_URL;
  const isLocal = dbUrl.includes("127.0.0.1") || dbUrl.includes("localhost");
  const client = new Client({ connectionString: dbUrl, ssl: isLocal ? undefined : { rejectUnauthorized: false } });
  await client.connect();
  try {
    const kanji = (await client.query<WritingRow>("SELECT id::text, entry_id, text, proficiency_band FROM jmdict_kanji")).rows;
    const kana = (await client.query<WritingRow>("SELECT id::text, entry_id, text, proficiency_band FROM jmdict_kana")).rows;
    if (kanji.length === 0) {
      console.error("jmdict_kanji is empty — run npm run ingest:jmdict first");
      process.exit(1);
    }

    const readingsOf = new Map<string, string[]>();
    for (const k of kana) {
      const list = readingsOf.get(k.entry_id) ?? [];
      list.push(k.text);
      readingsOf.set(k.entry_id, list);
    }

    const diff = (rows: WritingRow[]) =>
      rows
        .map((r) => ({ ...r, band: bandForWriting(table, r.text, readingsOf.get(r.entry_id) ?? []) }))
        .filter((r) => r.band !== r.proficiency_band);
    const kanjiChanges = diff(kanji);
    const kanaChanges = diff(kana);
    const entries = [...new Set([...kanjiChanges, ...kanaChanges].map((r) => r.entry_id))];

    const tally = (rows: ReturnType<typeof diff>) => ({
      cleared: rows.filter((r) => r.band === null).length,
      set: rows.filter((r) => r.proficiency_band === null).length,
      moved: rows.filter((r) => r.band !== null && r.proficiency_band !== null).length,
    });
    console.log(`jmdict_kanji: ${kanjiChanges.length} of ${kanji.length} change`, tally(kanjiChanges));
    console.log(`jmdict_kana:  ${kanaChanges.length} of ${kana.length} change`, tally(kanaChanges));
    console.log(`entries affected: ${entries.length}`);
    for (const r of listAll ? [...kanjiChanges, ...kanaChanges] : kanjiChanges.slice(0, 12)) {
      console.log(`  ${r.entry_id} ${r.text} [${(readingsOf.get(r.entry_id) ?? []).join("/")}] ${r.proficiency_band} → ${r.band}`);
    }
    if (dryRun) {
      console.log("--dry-run: nothing written");
      return;
    }
    if (entries.length === 0) {
      console.log("already up to date");
      return;
    }

    await client.query("BEGIN");
    for (const [name, rows] of [["jmdict_kanji", kanjiChanges], ["jmdict_kana", kanaChanges]] as const) {
      if (rows.length === 0) continue;
      await client.query(
        `UPDATE ${name} t SET proficiency_band = c.band
           FROM unnest($1::bigint[], $2::smallint[]) AS c(id, band)
          WHERE t.id = c.id`,
        [rows.map((r) => r.id), rows.map((r) => r.band)],
      );
    }
    // jmdict_lookup JA→EN's band expression, evaluated against each cached row's shown
    // writing (words.input): its own band as a kanji or kana writing of that entry, else
    // the entry's kanji band.
    const words = await client.query(
      `UPDATE words w
          SET proficiency_band = n.band
         FROM (
           SELECT w2.word_id,
                  COALESCE(
                    (SELECT kj.proficiency_band FROM jmdict_kanji kj
                      WHERE kj.entry_id = w2.jmdict_entry_id AND kj.text = w2.input LIMIT 1),
                    (SELECT k.proficiency_band FROM jmdict_kana k
                      WHERE k.entry_id = w2.jmdict_entry_id AND k.text = w2.input LIMIT 1),
                    jmdict_entry_kanji_band(w2.jmdict_entry_id)
                  ) AS band
             FROM words w2
            WHERE w2.source_lang = 'JA'
              AND w2.jmdict_entry_id = ANY($1::text[])
         ) n
        WHERE n.word_id = w.word_id
          AND w.proficiency_band IS DISTINCT FROM n.band`,
      [entries],
    );
    await client.query("COMMIT");
    console.log(`words: ${words.rowCount} cached JA→EN rows re-levelled`);

    await client.query("REFRESH MATERIALIZED VIEW CONCURRENTLY jmdict_entry_headword_mv");
    console.log("refreshed jmdict_entry_headword_mv");
    console.log("next: npm run build:leveling -- JA (the band anchors are measured from these bands)");
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
