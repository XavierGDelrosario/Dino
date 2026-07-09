// =========================================================
// Load data/proficiency/en.tsv → the server-only `english_proficiency` table (the
// CEFR level-label axis for ENGLISH-source words; see migration 20260722). Truncate +
// reload. One-time / regeneration tooling — NOT a runtime dependency. Mirror of
// scripts/ingest-english-frequency.ts.
//
// The edge function reads this table when projecting EN→JA lookups, overriding each
// word's proficiency_band with the English input's CEFR band (english_proficiency
// [lower(input)]) instead of the matched JA translation's JLPT band. Keys are
// LOWERCASED (the edge looks up lower(input)).
//
// USAGE:
//   python3 scripts/build-proficiency-cefr.py /tmp/cefr   # regenerate en.tsv first
//   npm run ingest:english-proficiency                    # local (127.0.0.1:54322) by default
//   DATABASE_URL='postgresql://postgres:<pwd>@db.<ref>.supabase.co:5432/postgres' \
//     npm run ingest:english-proficiency                  # a hosted project (SSL auto-enabled)
// =========================================================
import { readFileSync } from "node:fs";
import { Client } from "pg";

const DEFAULT_DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const TSV = new URL("../data/proficiency/en.tsv", import.meta.url);
const BATCH = 10000;

async function main(): Promise<void> {
  const rows = readFileSync(TSV, "utf8").trim().split("\n").map((l) => {
    const tab = l.indexOf("\t");
    return { surface: l.slice(0, tab).toLowerCase(), band: Number(l.slice(tab + 1)) };
  }).filter((r) => r.surface && Number.isInteger(r.band) && r.band >= 1 && r.band <= 6);
  // Dedup by lowercased surface, keeping the EASIEST (lowest) band — matches build-proficiency-cefr.py.
  const byKey = new Map<string, number>();
  for (const r of rows) byKey.set(r.surface, Math.min(byKey.get(r.surface) ?? Infinity, r.band));
  const surfaces = [...byKey.keys()];
  console.log(`loaded ${rows.length} rows → ${surfaces.length} unique surfaces`);

  const dbUrl = process.env.DATABASE_URL ?? DEFAULT_DB_URL;
  const isLocal = dbUrl.includes("127.0.0.1") || dbUrl.includes("localhost");
  const client = new Client({
    connectionString: dbUrl,
    ssl: isLocal ? undefined : { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    await client.query("TRUNCATE english_proficiency");
    for (let i = 0; i < surfaces.length; i += BATCH) {
      const chunk = surfaces.slice(i, i + BATCH);
      const bands = chunk.map((s) => byKey.get(s)!);
      await client.query(
        `INSERT INTO english_proficiency (surface, band)
         SELECT * FROM unnest($1::text[], $2::smallint[])
         ON CONFLICT (surface) DO UPDATE SET band = EXCLUDED.band`,
        [chunk, bands],
      );
    }
    const { rows: [{ n }] } = await client.query("SELECT count(*)::int n FROM english_proficiency");
    console.log(`english_proficiency now has ${n} rows`);
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
