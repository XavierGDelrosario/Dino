// =========================================================
// MEASURE a language's leveling profile and write it to the registry tables
// (language_leveling / language_pos_offset — see migration 20260731).
//
// The SRS ease needs to know two things about a language, and BOTH are measurements,
// not opinions, so they are derived here from that language's own ingested data rather
// than hand-written into a migration:
//
//   1. BAND ANCHORS — where each proficiency band actually sits on the corpus-frequency
//      scale (the median frequency of its words). This is what makes the ease honest
//      about NON-UNIFORM band spacing: for JLPT the steps are N5→N4 0.25 Zipf, N4→N3
//      0.26, N3→N2 0.64, N2→N1 0.02 — nothing like the equal steps an ordinal
//      subtraction would assume.
//
//   2. POS FREQUENCY OFFSETS — how much a part of speech's corpus frequency OVERSTATES
//      its ease, measured as its mean frequency relative to the median of its own band.
//      Corpus frequency is per-SURFACE, so inflection splits a word's mass across its
//      forms: Japanese affixes/counters never inflect and so concentrate all of theirs
//      (+0.60 Zipf), while verbs are heavily inflected and look rarer than they are
//      (−0.76 Zipf). Only POSITIVE offsets are stored — the correction may make a word
//      look HARDER than its raw frequency, never easier (the loss is asymmetric: wrongly
//      retiring a word is expensive, wrongly reviewing it is nearly free; correcting
//      verbs "toward" the band blew their over-easy rate from 0.9% to 15% when measured).
//
// See docs/research/Frequency_vs_Proficiency_by_POS.md for the full analysis.
//
// Per-language SOURCES are the one language-specific thing here (JA levels live in
// jmdict_*, EN levels in english_*), so each language gets a small resolver below. A
// language with no measurable data simply gets no profile → the scheduler's ease is 1.0
// for it → today's behaviour. Nothing is ever confidently wrong for a language we have
// not measured.
//
// USAGE:
//   npm run build:leveling -- JA          # local (127.0.0.1:54322) by default
//   DATABASE_URL='postgresql://…' npm run build:leveling -- EN
// Re-run after re-ingesting frequency or proficiency data for that language.
// =========================================================
import { Client } from "pg";

const DEFAULT_DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/** A language's leveling sources: one query yielding (band, frequency, pos_group) rows,
 *  plus the framework name. `pos_group` is NULL when the language has no POS source —
 *  English is exactly that case today (words.part_of_speech on an EN row holds JMdict
 *  JAPANESE tags describing the translation), so it gets band anchors and no offsets. */
interface LevelingSource {
  framework: string;
  /** Rows: { band, frequency, pos_group | null } over the language's LEVELLED words. */
  sql: string;
}

const SOURCES: Record<string, LevelingSource> = {
  JA: {
    framework: "JLPT",
    // JMdict kanji surfaces carrying both a JLPT band and a wordfreq frequency, with the
    // POS group of their entry's PRIMARY sense (pos_group_of resolves the tag priority).
    sql: `
      WITH prim AS (
        SELECT DISTINCT ON (entry_id) entry_id, part_of_speech
          FROM jmdict_senses ORDER BY entry_id, id
      )
      SELECT DISTINCT k.text,
             k.proficiency_band AS band,
             k.frequency        AS frequency,
             pos_group_of('JA', p.part_of_speech) AS pos_group
        FROM jmdict_kanji k
        JOIN prim p ON p.entry_id = k.entry_id
       WHERE k.proficiency_band IS NOT NULL AND k.frequency IS NOT NULL`,
  },
  EN: {
    framework: "CEFR",
    // CEFR wordlist ∩ the English frequency table. NO pos_group: there is no English POS
    // source (see the header), so English gets anchors only — and its ease therefore
    // relies on the curated band, which is the conservative outcome.
    sql: `
      SELECT p.surface AS text,
             p.band    AS band,
             f.frequency AS frequency,
             NULL::text  AS pos_group
        FROM english_proficiency p
        JOIN english_frequency  f ON f.surface = p.surface`,
  },
};

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

async function main(): Promise<void> {
  const lang = (process.argv[2] ?? "").toUpperCase();
  const source = SOURCES[lang];
  if (!source) {
    console.error(`usage: npm run build:leveling -- <${Object.keys(SOURCES).join("|")}>`);
    process.exit(1);
  }

  const url = process.env.DATABASE_URL ?? DEFAULT_DB_URL;
  const client = new Client({
    connectionString: url,
    ssl: url.includes("127.0.0.1") || url.includes("localhost") ? undefined : { rejectUnauthorized: false },
  });
  await client.connect();

  const { rows } = await client.query<{ band: number; frequency: number; pos_group: string | null }>(
    source.sql,
  );
  if (rows.length === 0) {
    console.error(
      `no levelled words for ${lang} — is its frequency + proficiency data ingested? ` +
        `Nothing written; the scheduler will use ease 1.0 for ${lang}.`,
    );
    await client.end();
    process.exit(1);
  }
  console.log(`${lang}: ${rows.length} levelled words`);

  // 1. Band anchors: the median frequency of each band. Bands are 1..n, ascending = harder.
  const byBand = new Map<number, number[]>();
  for (const r of rows) {
    if (!byBand.has(r.band)) byBand.set(r.band, []);
    byBand.get(r.band)!.push(r.frequency);
  }
  const maxBand = Math.max(...byBand.keys());
  const anchors: number[] = [];
  for (let b = 1; b <= maxBand; b++) {
    const freqs = byBand.get(b);
    if (!freqs?.length) {
      // A band with no data can't be anchored; interpolate later is overkill — refuse,
      // because a wrong anchor silently mis-schedules every word at that level.
      console.error(`band ${b} has no levelled words — cannot anchor ${lang}. Nothing written.`);
      await client.end();
      process.exit(1);
    }
    anchors.push(Math.round(median(freqs) * 100) / 100);
  }
  const bandMedian = new Map<number, number>(anchors.map((a, i) => [i + 1, a]));
  console.log(
    `  band anchors (median frequency, Zipf×100): ` +
      anchors.map((a, i) => `${i + 1}:${a}`).join("  "),
  );

  // 2. POS offsets: mean frequency of the group RELATIVE to the median of its own band.
  //    Only positive offsets are kept (rule: correct a word harder, never easier).
  const byGroup = new Map<string, number[]>();
  for (const r of rows) {
    if (!r.pos_group) continue;
    const delta = r.frequency - bandMedian.get(r.band)!;
    if (!byGroup.has(r.pos_group)) byGroup.set(r.pos_group, []);
    byGroup.get(r.pos_group)!.push(delta);
  }
  const offsets = [...byGroup.entries()]
    .map(([group, deltas]) => ({ group, n: deltas.length, raw: mean(deltas) }))
    .filter((o) => o.n >= 25) // too few to measure → no offset rather than a noisy one
    .map((o) => ({ ...o, offset: Math.max(0, Math.round(o.raw * 100) / 100) }));

  for (const o of offsets) {
    const dir = o.raw > 0 ? "inflated" : "deflated (left alone — safe direction)";
    console.log(
      `  ${o.group.padEnd(12)} n=${String(o.n).padStart(5)}  ` +
        `${o.raw >= 0 ? "+" : ""}${o.raw.toFixed(1)} vs its band  → offset ${o.offset}  (${dir})`,
    );
  }
  if (offsets.length === 0) console.log(`  no POS source for ${lang} → no offsets (band-led ease)`);

  // 3. Write the profile (upsert — re-running after a re-ingest just refreshes it, and
  //    because the scheduler reads this at REVIEW time, the new values apply immediately
  //    and retroactively to every word).
  await client.query("BEGIN");
  await client.query(
    `INSERT INTO language_leveling (language, framework, band_anchors, measured_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (language) DO UPDATE
       SET framework = EXCLUDED.framework,
           band_anchors = EXCLUDED.band_anchors,
           measured_at = EXCLUDED.measured_at`,
    [lang, source.framework, anchors],
  );
  await client.query(`DELETE FROM language_pos_offset WHERE language = $1`, [lang]);
  for (const o of offsets.filter((x) => x.offset > 0)) {
    await client.query(
      `INSERT INTO language_pos_offset (language, pos_group, freq_offset) VALUES ($1, $2, $3)`,
      [lang, o.group, o.offset],
    );
  }
  await client.query("COMMIT");
  await client.end();
  console.log(`✓ ${lang} profile written (ease is now live for ${lang} words)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
