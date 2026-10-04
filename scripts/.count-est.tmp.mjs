// LOCAL-ONLY, read-only: what is still unwritten in the estimated-level scope.
import pg from "pg";
import fs from "node:fs";
const done = new Set(fs.readFileSync("data/sense_examples/ja.tsv", "utf8").split("\n").filter((l) => l && !l.startsWith("#")).map((l) => l.split("\t")[0]));
const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
const r = await c.query(`
  WITH est AS (
    SELECT h.entry_id, h.writing, COALESCE(h.frequency,0) f,
           COALESCE((SELECT k.estimated_band FROM jmdict_kanji k WHERE k.entry_id = h.entry_id AND k.text = h.writing LIMIT 1),
                    (SELECT k.estimated_band FROM jmdict_kana  k WHERE k.entry_id = h.entry_id AND k.text = h.writing LIMIT 1)) AS eb
      FROM jmdict_entry_headword_mv h
     WHERE h.proficiency_band IS NULL AND h.writing !~ '^[ァ-ヶー・]+$')
  SELECT e.entry_id, e.f, s.position FROM est e JOIN jmdict_senses s ON s.entry_id = e.entry_id WHERE e.eb IS NOT NULL AND e.f < 400`);
await c.end();
const t = {};
const bump = (k) => (t[k] = (t[k] ?? 0) + 1);
for (const x of r.rows) {
  if (done.has(`${x.entry_id}:${x.position}`)) { bump("written"); continue; }
  const ahead = x.f < 300 || (x.f === 300 && Number(x.entry_id) > 1514540);
  if (x.position === 0) bump(ahead ? "first sense, not reached yet" : "first sense, passed over (skipped)");
  else bump(x.position === 1 ? "second sense" : "third sense or later");
}
console.log(t);
