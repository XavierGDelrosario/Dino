// LOCAL-ONLY helper for expcreate: the next unwritten senses (read-only).
// usage: node scripts/.next-senses.tmp.mjs <freq> <entry_id>          (tier b: freq ≥ 400, ascending)
//        node scripts/.next-senses.tmp.mjs jlpt <freq> <entry_id>     (tier c: JLPT band set, freq < 400,
//                                                                      most common first; resume BELOW <freq>/<entry>)
import pg from "pg";
import fs from "node:fs";
const jlpt = process.argv[2] === "jlpt";
const [f, e] = jlpt ? [Number(process.argv[3]), process.argv[4]] : [Number(process.argv[2]), process.argv[3]];
const done = new Set(fs.readFileSync("data/sense_examples/ja.tsv", "utf8").split("\n").filter((l) => l && !l.startsWith("#")).map((l) => l.split("\t")[0]));
const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
const where = jlpt
  ? `h.proficiency_band IS NOT NULL AND COALESCE(h.frequency, 0) < 400
     AND (COALESCE(h.frequency, 0) < $1 OR (COALESCE(h.frequency, 0) = $1 AND h.entry_id > $2))`
  : `h.frequency >= $1 AND (h.frequency > $1 OR h.entry_id > $2)`;
const order = jlpt ? `COALESCE(h.frequency, 0) DESC, h.entry_id, s.position` : `h.frequency, h.entry_id, s.position`;
const r = await c.query(`
  SELECT h.entry_id, h.writing, h.reading, h.frequency, h.proficiency_band b, s.position,
         s.part_of_speech pos, string_agg(g.text, '; ' ORDER BY g.position) gloss
    FROM jmdict_entry_headword_mv h
    JOIN jmdict_senses s ON s.entry_id = h.entry_id
    JOIN jmdict_glosses g ON g.sense_id = s.id
   WHERE ${where}
     AND h.writing !~ '^[ァ-ヶー・]+$'
     ${process.env.BANDS ? `AND h.proficiency_band = ANY($3::int[])` : ""}
   GROUP BY 1,2,3,4,5,6,7
   ORDER BY ${order}
   LIMIT 2000`, process.env.BANDS ? [f, e, process.env.BANDS.split(",").map(Number)] : [f, e]);
await c.end();
const todo = r.rows.filter((x) => !done.has(`${x.entry_id}:${x.position}`)).slice(0, 400);
for (const x of todo) console.log([`${x.entry_id}:${x.position}`, x.writing, x.reading ?? "", x.frequency, x.b ?? "", (x.pos ?? []).join(","), x.gloss.slice(0, 90)].join("\t"));
