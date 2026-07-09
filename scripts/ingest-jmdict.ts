// =========================================================
// JMdict ingest loader (one-time, server-side ETL).
//
// Reads a scriptin/jmdict-simplified `jmdict-eng-*.json` release and bulk-loads
// it into the normalized jmdict_* tables (see supabase/migrations/20260618_jmdict.sql).
// The translate edge function then queries those tables via jmdict_lookup().
//
// This writes ONLY the jmdict_* tables. It NEVER touches words / user_words /
// lists / list_words, and it does NOT pre-seed `readings` (the edge function
// fills that lazily). Re-running is safe: it truncates and reloads in one txn.
//
// JMdict is owned by EDRDG and used under their licence (attribution required).
//
// USAGE:
//   1. Download a release JSON, e.g. jmdict-eng-common-<ver>.json (POC) or the
//      full jmdict-eng-<ver>.json, from
//      https://github.com/scriptin/jmdict-simplified/releases
//   2. Point at your local Supabase Postgres (default below) or set DATABASE_URL:
//        npm run ingest:jmdict -- ./jmdict-eng-common-3.x.x.json [--common-only]
//   Either edition works for content (the common subset is plenty for the POC).
//   FREQUENCY is sourced separately from data/frequency/ja.tsv (wordfreq-derived,
//   see scripts/build-frequency.py) — jmdict-simplified has no usable frequency
//   codes. Add --common-only to store just the common subset (small DB footprint).
//   The default DB URL is the local Supabase superuser (bypasses RLS), which is
//   what `supabase start` exposes on port 54322.
// =========================================================
import { readFileSync } from "node:fs";
import { Client } from "pg";

const DEFAULT_DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

// --- jmdict-simplified JSON shape (only the fields we load) ----------------
interface JMKanji { text: string; common: boolean }
interface JMKana { text: string; common: boolean; appliesToKanji: string[] }
interface JMGloss { lang: string; text: string }
interface JMSense {
  partOfSpeech: string[];
  appliesToKanji: string[];
  appliesToKana: string[];
  misc: string[];
  gloss: JMGloss[];
}
interface JMWord { id: string; kanji: JMKanji[]; kana: JMKana[]; sense: JMSense[] }
interface JMDict { version?: string; dictDate?: string; words: JMWord[] }

const nfc = (s: string) => s.normalize("NFC");

// Frequency comes from the wordfreq-derived file (data/frequency/<lang>.tsv,
// "<surface>\t<zipf×100>", built by scripts/build-frequency.py) — NOT from JMdict
// (jmdict-simplified collapses all priority codes into the `common` boolean, so
// nfXX is unavailable; verified against the full dataset). The score is a
// NORMALIZED Zipf value (higher = MORE common), joined onto each writing/reading
// by surface and stored on jmdict_kanji/kana.frequency, which jmdict_lookup
// aggregates (GREATEST) into words.frequency. Missing surface → NULL (unranked).
const FREQ_FILE = (lang: string) =>
  new URL(`../data/frequency/${lang}.tsv`, import.meta.url);

/** Load "<surface>\t<score>" → Map(surface → score). Empty map if the file is absent. */
function loadFrequencies(lang: string): Map<string, number> {
  const map = new Map<string, number>();
  let raw: string;
  try {
    raw = readFileSync(FREQ_FILE(lang), "utf8");
  } catch {
    console.warn(
      `No frequency file for '${lang}' (data/frequency/${lang}.tsv) — frequencies will be NULL. ` +
        `Generate it with: scripts/build-frequency.py ${lang}`
    );
    return map;
  }
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const tab = line.indexOf("\t");
    if (tab === -1) continue;
    map.set(nfc(line.slice(0, tab)), Number(line.slice(tab + 1)));
  }
  return map;
}

// PROFICIENCY band (the curated proficiency-label axis, services/proficiency) is
// sourced like frequency: data/proficiency/<lang>.tsv ("<surface>\t<band>", built
// by scripts/build-proficiency.py — JLPT for JA), joined onto jmdict_kanji/kana by
// surface. jmdict_lookup then takes the HEADWORD's band (same pick as frequency)
// and the edge projects it onto words.proficiency_band. Missing surface → NULL.
const PROF_FILE = (lang: string) =>
  new URL(`../data/proficiency/${lang}.tsv`, import.meta.url);

/** Load "<surface>\t<band>" → Map(surface → band). Empty map if the file is absent. */
function loadProficiency(lang: string): Map<string, number> {
  const map = new Map<string, number>();
  let raw: string;
  try {
    raw = readFileSync(PROF_FILE(lang), "utf8");
  } catch {
    console.warn(
      `No proficiency file for '${lang}' (data/proficiency/${lang}.tsv) — bands will be NULL. ` +
        `Generate it with: scripts/build-proficiency.py <src-dir> --lang ${lang}`
    );
    return map;
  }
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const tab = line.indexOf("\t");
    if (tab === -1) continue;
    map.set(nfc(line.slice(0, tab)), Number(line.slice(tab + 1)));
  }
  return map;
}

/** Bulk multi-row INSERT, chunked to stay under Postgres' ~65535 param cap. */
async function bulkInsert(
  client: Client,
  table: string,
  columns: string[],
  rows: unknown[][],
  returning?: string
): Promise<Record<string, unknown>[]> {
  if (rows.length === 0) return [];
  const cols = columns.length;
  const batchSize = Math.max(1, Math.floor(60000 / cols));
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const params: unknown[] = [];
    const tuples = batch.map((row, r) => {
      const ph = row.map((_, c) => `$${r * cols + c + 1}`);
      params.push(...row);
      return `(${ph.join(",")})`;
    });
    const sql =
      `INSERT INTO ${table} (${columns.join(",")}) VALUES ${tuples.join(",")}` +
      (returning ? ` RETURNING ${returning}` : "");
    const res = await client.query(sql, params);
    if (returning) out.push(...res.rows);
  }
  return out;
}

/** An entry is "common" if any of its kanji or kana readings is flagged common. */
function isCommonEntry(w: JMWord): boolean {
  return w.kanji.some((k) => k.common) || w.kana.some((k) => k.common);
}

async function main(): Promise<void> {
  // Args: the JSON path plus an optional --common-only flag (order-independent).
  const args = process.argv.slice(2);
  const commonOnly = args.includes("--common-only");
  const file = args.find((a) => !a.startsWith("--"));
  if (!file) {
    console.error(
      "Usage: npm run ingest:jmdict -- <path-to-jmdict-eng.json> [--common-only]"
    );
    process.exit(1);
  }
  const dbUrl = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

  console.log(`Reading ${file} ...`);
  const dict = JSON.parse(readFileSync(file, "utf8")) as JMDict;
  const all = dict.words ?? [];
  // --common-only: store ONLY common entries (those with a common reading/writing)
  // to keep the DB at the small ~common-subset footprint; dropped rare entries are
  // read-and-discarded, never inserted (see CLAUDE.md #7 storage decision). Without
  // the flag, every entry is stored (full ingest). Frequency is independent of this
  // (it comes from the wordfreq file), so either way stored words get a score.
  const words = commonOnly ? all.filter(isCommonEntry) : all;
  console.log(
    `Parsed ${all.length} entries (JMdict ${dict.version ?? "?"}, ${dict.dictDate ?? "?"}).` +
      (commonOnly
        ? ` Keeping ${words.length} common (dropping ${all.length - words.length} rare).`
        : "")
  );

  // wordfreq-derived surface → Zipf score (see loadFrequencies). JMdict is Japanese.
  const freq = loadFrequencies("ja");
  const freqOf = (surface: string) => freq.get(nfc(surface)) ?? null;

  // JLPT surface → band (see loadProficiency). Joined by surface like frequency.
  const prof = loadProficiency("ja");
  const bandOf = (surface: string) => prof.get(nfc(surface)) ?? null;

  // Flatten into per-table row arrays. Senses keep their glosses so we can wire
  // them up once Postgres hands back the generated sense ids (in insertion order).
  const entries: unknown[][] = [];
  const kanji: unknown[][] = [];
  const kana: unknown[][] = [];
  const senses: unknown[][] = [];
  const senseGlosses: JMGloss[][] = []; // parallel to `senses`

  for (const w of words) {
    entries.push([w.id]);
    w.kanji.forEach((k, i) =>
      kanji.push([w.id, nfc(k.text), k.common, freqOf(k.text), bandOf(k.text), i])
    );
    w.kana.forEach((k, i) =>
      kana.push([w.id, nfc(k.text), k.common, k.appliesToKanji ?? ["*"], freqOf(k.text), bandOf(k.text), i])
    );
    w.sense.forEach((s, i) => {
      senses.push([
        w.id,
        s.partOfSpeech ?? [],
        s.appliesToKanji ?? ["*"],
        s.appliesToKana ?? ["*"],
        // "uk" = usually written using kana alone → the entry should headline as
        // kana, with the kanji shown as an annotation (see jmdict_lookup).
        (s.misc ?? []).includes("uk"),
        i,
      ]);
      senseGlosses.push(s.gloss ?? []);
    });
  }

  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  const started = Date.now();
  try {
    await client.query("BEGIN");
    console.log("Truncating jmdict_* tables ...");
    await client.query(
      "TRUNCATE jmdict_glosses, jmdict_senses, jmdict_kana, jmdict_kanji, jmdict_entries RESTART IDENTITY CASCADE"
    );

    console.log(`Inserting ${entries.length} entries ...`);
    await bulkInsert(client, "jmdict_entries", ["entry_id"], entries);

    console.log(`Inserting ${kanji.length} kanji ...`);
    await bulkInsert(client, "jmdict_kanji", ["entry_id", "text", "common", "frequency", "proficiency_band", "position"], kanji);

    console.log(`Inserting ${kana.length} kana ...`);
    await bulkInsert(
      client,
      "jmdict_kana",
      ["entry_id", "text", "common", "applies_to_kanji", "frequency", "proficiency_band", "position"],
      kana
    );

    console.log(`Inserting ${senses.length} senses ...`);
    const senseRows = await bulkInsert(
      client,
      "jmdict_senses",
      ["entry_id", "part_of_speech", "applies_to_kanji", "applies_to_kana", "usually_kana", "position"],
      senses,
      "id"
    );
    if (senseRows.length !== senses.length) {
      throw new Error(
        `sense id count mismatch: got ${senseRows.length}, expected ${senses.length}`
      );
    }

    // Wire glosses to their now-known sense ids (RETURNING preserves insert order).
    const glosses: unknown[][] = [];
    senseRows.forEach((row, i) => {
      const senseId = row.id as number;
      senseGlosses[i].forEach((g, j) => glosses.push([senseId, g.lang, nfc(g.text), j]));
    });

    console.log(`Inserting ${glosses.length} glosses ...`);
    await bulkInsert(client, "jmdict_glosses", ["sense_id", "lang", "text", "position"], glosses);

    await client.query("COMMIT");
    console.log(
      `Done in ${((Date.now() - started) / 1000).toFixed(1)}s — ` +
        `${entries.length} entries, ${kanji.length} kanji, ${kana.length} kana, ` +
        `${senses.length} senses, ${glosses.length} glosses.`
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
