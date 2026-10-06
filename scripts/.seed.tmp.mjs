// LOCAL-ONLY demo seed for the profile History section. Creates demo@dino.local.
import pg from "pg";
const SK = process.env.SK;
const email = "demo@dino.local", password = "demo-history-123";
let res = await fetch("http://127.0.0.1:54321/auth/v1/admin/users", {
  method: "POST",
  headers: { apikey: SK, Authorization: `Bearer ${SK}`, "Content-Type": "application/json" },
  body: JSON.stringify({ email, password, email_confirm: true }),
});
let body = await res.json();
const c = new pg.Client({ connectionString: "postgresql://postgres:postgres@127.0.0.1:54322/postgres" });
await c.connect();
let uid = body.id;
if (!uid) uid = (await c.query(`select id from auth.users where email=$1`, [email])).rows[0].id;
await c.query(`insert into users (user_id, email, learning_language, native_language) values ($1,$2,'JA','EN')
               on conflict (user_id) do update set email=excluded.email`, [uid, email]);
await c.query(`delete from user_words where user_id=$1`, [uid]);
await c.query(`delete from user_confidence_daily where user_id=$1`, [uid]);
// deterministic PRNG
let s = 42; const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
const words = (await c.query(`select word_id, input, proficiency_band from words
  where source_lang='JA' and target_lang='EN' order by word_id limit 900`)).rows;
const DAYS = 120, now = Date.now(), DAY = 86400000;
let i = 0;
for (let d = DAYS; d >= 0 && i < words.length; d--) {
  if (rnd() < 0.25) continue; // idle day
  const n = Math.floor(rnd() * 14);
  for (let k = 0; k < n && i < words.length; k++, i++) {
    const w = words[i];
    const added = new Date(now - d * DAY - rnd() * 8 * 3600000);
    const band = w.proficiency_band ?? 3;
    const stab = Math.max(0.5, (7 - band) * 6 * rnd() + (d / 10));
    const lastRev = d > 1 ? new Date(now - Math.floor(rnd() * Math.min(d, 20)) * DAY) : null;
    const r = await c.query(
      `insert into user_words (user_id, input, source_lang, target_lang, dictionary_word_id,
         originally_translated_date, stability, last_reviewed_date, peak_confidence)
       values ($1,$2,'JA','EN',$3,$4,$5,$6,$7) returning user_word_id`,
      [uid, w.input, w.word_id, added, lastRev ? stab : null, lastRev, lastRev ? Math.min(5, Math.round(stab / 8)) : 0],
    );
    // a few review days per word
    const reviews = Math.floor(rnd() * Math.min(6, d));
    const seen = new Set();
    for (let q = 0; q < reviews; q++) {
      const rd = Math.floor(rnd() * d);
      if (seen.has(rd)) continue; seen.add(rd);
      await c.query(`insert into review_log (user_word_id, user_id, grade, reviewed_at, repeats, new_stability)
                     values ($1,$2,$3,$4,$5,$6)`,
        [r.rows[0].user_word_id, uid, 1 + Math.floor(rnd() * 5), new Date(now - rd * DAY - rnd() * 3600000), 1 + Math.floor(rnd() * 2), stab]);
    }
  }
}
// Synthetic confidence snapshots for the last 60 days (demo only: real ones are written nightly).
for (let d = 60; d >= 1; d--) {
  if (rnd() < 0.2) continue;
  const day = new Date(now - d * DAY).toISOString().slice(0, 10);
  const t = (60 - d) / 60;
  const conf = [0, 1, 2, 3, 4, 5].map((b) => b === 0 ? 1.2 + t * 0.8 : Math.min(5, (6 - b) * 0.45 + t * 1.6 + rnd() * 0.3));
  const n = [120, 150, 180, 160, 90, 60].map((x) => Math.round(x * (0.5 + t / 2)));
  await c.query(`insert into user_confidence_daily (user_id, day, word_count, avg_conf, main_lang, band_n, band_conf)
                 values ($1,$2,$3,$4,'JA',$5,$6)`,
    [uid, day, n.reduce((a, b) => a + b, 0), 1.4 + t * 1.3, n, conf]);
}
const cnt = await c.query(`select (select count(*) from user_words where user_id=$1) words,
  (select count(*) from review_log where user_id=$1) reviews,
  (select count(*) from user_confidence_daily where user_id=$1) snaps`, [uid]);
console.log(email, password, cnt.rows[0]);
await c.end();
