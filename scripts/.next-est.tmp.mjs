// LOCAL-ONLY helper (read-only): next unwritten senses in the ESTIMATED-LEVEL scope —
// headwords with no curated JLPT band but an estimated one, non-katakana, most common
// first. usage: node scripts/.next-est.tmp.mjs <freq> <entry_id> [limit]
//   resumes BELOW <freq>, or at <freq> with entry_id > <entry_id>.
import pg from "pg";
import fs from "node:fs";
const [f, e, lim] = [Number(process.argv[2]), process.argv[3], Number(process.argv[4] ?? 80)];
const done = new Set(fs.readFileSync("data/sense_examples/ja.tsv", "utf8").split("\n").filter((l) => l && !l.startsWith("#")).map((l) => l.split("\t")[0]));
const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
const r = await c.query(`
  WITH est AS (
    SELECT h.*, COALESCE((SELECT k.estimated_band FROM jmdict_kanji k WHERE k.entry_id = h.entry_id AND k.text = h.writing LIMIT 1),
                         (SELECT k.estimated_band FROM jmdict_kana  k WHERE k.entry_id = h.entry_id AND k.text = h.writing LIMIT 1)) AS eb
      FROM jmdict_entry_headword_mv h
     WHERE h.proficiency_band IS NULL AND h.writing !~ '^[ァ-ヶー・]+$'
       AND (COALESCE(h.frequency,0) < $1 OR (COALESCE(h.frequency,0) = $1 AND h.entry_id > $2))
  )
  SELECT e.entry_id, e.writing, e.reading, e.frequency, e.eb, s.position, s.part_of_speech pos,
         string_agg(g.text, '; ' ORDER BY g.position) gloss
    FROM est e JOIN jmdict_senses s ON s.entry_id = e.entry_id JOIN jmdict_glosses g ON g.sense_id = s.id
   WHERE e.eb IS NOT NULL
   GROUP BY 1,2,3,4,5,6,7
   ORDER BY COALESCE(e.frequency,0) DESC, e.entry_id, s.position
   LIMIT ${Number(process.env.SQL_LIMIT ?? 1500)}`, [f, e]);
await c.end();
// ONLYPOS=n: later-sense pass — only senses at that position whose FIRST sense is already written.
const only = process.env.ONLYPOS ? Number(process.env.ONLYPOS) : null;
const todo = r.rows.filter((x) => !done.has(`${x.entry_id}:${x.position}`) && (only === null || (x.position === only && done.has(`${x.entry_id}:0`)))).slice(0, lim);
// TERSE=1: only what an author needs — drops single-kanji and kana-only headwords, sense
// positions past 1, and affix/counter/pronoun/expression senses (all near-always skipped).
const SKIP = new Set(["suf", "pref", "ctr", "pn", "exp", "int", "n-suf", "n-pref", "num"]);
for (const x of todo) {
  if (only !== null) {
    if ((x.pos ?? []).length && SKIP.has(x.pos[0])) continue;
    console.log([`${x.entry_id}:${x.position}`, x.writing, x.reading ?? "", x.frequency, (x.pos ?? []).slice(0, 2).join(","), x.gloss.slice(0, 60)].join("\t"));
    continue;
  }
  if (process.env.TERSE) {
    if ([...x.writing].length < 2 || !/[一-龯]/.test(x.writing) || x.position > 1) continue;
    if ((x.pos ?? []).length && SKIP.has(x.pos[0])) continue;
    console.log([`${x.entry_id}:${x.position}`, x.writing, x.reading ?? "", x.frequency, x.gloss.slice(0, 44)].join("\t"));
    continue;
  }
  console.log([`${x.entry_id}:${x.position}`, x.writing, x.reading ?? "", x.frequency, `e${x.eb}`, (x.pos ?? []).join(","), x.gloss.slice(0, 80)].join("\t"));
}
