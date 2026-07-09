// =========================================================
// Load data/frequency/en.tsv → the server-only `english_frequency` table (the
// DIFFICULTY axis for ENGLISH-source words; see migration 20260721). Truncate +
// reload, like the JMdict ingest. One-time / regeneration tooling — NOT a runtime
// dependency.
//
// The edge function reads this table when projecting EN→JA lookups, overriding each
// word's frequency with the English input's OWN value (english_frequency[lower(input)])
// instead of the matched JA translation's. Keys are LOWERCASED (wordfreq keys are
// lowercase; the edge looks up lower(input)).
//
// USAGE:
//   npm run build:freq:en           # regenerate data/frequency/en.tsv first (wordfreq)
//   npm run ingest:english-frequency # local (127.0.0.1:54322) by default
//   DATABASE_URL='postgresql://postgres:<pwd>@db.<ref>.supabase.co:5432/postgres' \
//     npm run ingest:english-frequency   # a hosted project (SSL auto-enabled)
// =========================================================
import { readFileSync } from "node:fs";
import { Client } from "pg";

const DEFAULT_DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const TSV = new URL("../data/frequency/en.tsv", import.meta.url);
const BATCH = 10000;

async function main(): Promise<void> {
  const rows = readFileSync(TSV, "utf8").trim().split("\n").map((l) => {
    const tab = l.indexOf("\t");
    return { surface: l.slice(0, tab).toLowerCase(), frequency: Number(l.slice(tab + 1)) };
  }).filter((r) => r.surface && Number.isFinite(r.frequency));
  // Dedup by lowercased surface (case-folding can collide), keeping the max frequency.
  const byKey = new Map<string, number>();
  for (const r of rows) byKey.set(r.surface, Math.max(byKey.get(r.surface) ?? -Infinity, r.frequency));
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
    await client.query("TRUNCATE english_frequency");
    for (let i = 0; i < surfaces.length; i += BATCH) {
      const chunk = surfaces.slice(i, i + BATCH);
      const freqs = chunk.map((s) => byKey.get(s)!);
      await client.query(
        `INSERT INTO english_frequency (surface, frequency)
         SELECT * FROM unnest($1::text[], $2::int[])
         ON CONFLICT (surface) DO UPDATE SET frequency = EXCLUDED.frequency`,
        [chunk, freqs],
      );
    }
    const { rows: [{ n }] } = await client.query("SELECT count(*)::int n FROM english_frequency");
    console.log(`english_frequency now has ${n} rows`);
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
