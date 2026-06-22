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
//        npm run ingest:jmdict -- ./jmdict-eng-common-3.x.x.json
//   The default DB URL is the local Supabase superuser (bypasses RLS), which is
//   what `supabase start` exposes on port 54322.
// =========================================================
import { readFileSync } from "node:fs";
import { Client } from "pg";

const DEFAULT_DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

// --- jmdict-simplified JSON shape (only the fields we load) ----------------
interface JMKanji { text: string; common: boolean; tags: string[] }
interface JMKana { text: string; common: boolean; appliesToKanji: string[]; tags: string[] }
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

// JMdict priority tags → a numeric frequency RANK (lower = more common; NULL =
// unranked). nfXX (X=01..48) is the finest signal (newspaper-frequency bin), so
// it wins when present; otherwise the coarse top-tier "1" bins (news1/ichi1/
// spec1/gai1) rank ahead of the "2" bins. The `-common` JSON strips these
// granular codes (keeping only the `common` boolean), so every element gets NULL
// there; the full jmdict-eng dataset carries them. Mirrors jmdict_kanji.frequency
// in the migration and feeds jmdict_lookup's ORDER BY + words.frequency.
const PRIORITY_1 = new Set(["news1", "ichi1", "spec1", "gai1"]);
const PRIORITY_2 = new Set(["news2", "ichi2", "spec2", "gai2"]);
function frequencyRank(tags: string[]): number | null {
  let best: number | null = null;
  for (const t of tags) {
    const m = /^nf(\d{2})$/.exec(t);
    if (m) {
      const n = Number(m[1]);
      best = best === null ? n : Math.min(best, n);
    }
  }
  if (best !== null) return best;                 // nfXX: 1..48
  if (tags.some((t) => PRIORITY_1.has(t))) return 49;
  if (tags.some((t) => PRIORITY_2.has(t))) return 99;
  return null;
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

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file) {
    console.error("Usage: npm run ingest:jmdict -- <path-to-jmdict-eng.json>");
    process.exit(1);
  }
  const dbUrl = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

  console.log(`Reading ${file} ...`);
  const dict = JSON.parse(readFileSync(file, "utf8")) as JMDict;
  const words = dict.words ?? [];
  console.log(
    `Parsed ${words.length} entries (JMdict ${dict.version ?? "?"}, ${dict.dictDate ?? "?"}).`
  );

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
      kanji.push([w.id, nfc(k.text), k.common, frequencyRank(k.tags ?? []), i])
    );
    w.kana.forEach((k, i) =>
      kana.push([w.id, nfc(k.text), k.common, k.appliesToKanji ?? ["*"], frequencyRank(k.tags ?? []), i])
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
    await bulkInsert(client, "jmdict_kanji", ["entry_id", "text", "common", "frequency", "position"], kanji);

    console.log(`Inserting ${kana.length} kana ...`);
    await bulkInsert(
      client,
      "jmdict_kana",
      ["entry_id", "text", "common", "applies_to_kanji", "frequency", "position"],
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
