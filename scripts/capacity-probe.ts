// =========================================================
// Capacity probe (READ-ONLY) — "how many users can the current deploy support?"
//
// Measures the FOUNDER's actual footprint on prod (rows, bytes, MT chars, per-day
// activity) so the headroom question is answered from real usage instead of guesses.
// Every statement is a SELECT; nothing is written. Same direct-Postgres connection
// pattern as scripts/mt-usage.ts (service role / superuser bypasses RLS).
//
//   npx tsx scripts/capacity-probe.ts [--env=prod|staging]
// =========================================================
import { readFileSync } from "node:fs";
import { Client } from "pg";

const ENV = (process.argv.find((a) => a.startsWith("--env="))?.split("=")[1] ?? "prod") as
  | "prod"
  | "staging";

function readEnvFile(path: string): Record<string, string> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    let v = m[2].trim();
    if (v.startsWith("#")) continue;
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

const file = readEnvFile(ENV === "prod" ? ".env.deploy" : ".env.deploy.staging");
const url = `postgresql://postgres:${encodeURIComponent(file.SUPABASE_DB_PASSWORD)}@db.${file.SUPABASE_PROJECT_REF}.supabase.co:5432/postgres`;

async function main() {
  const c = new Client({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
    statement_timeout: 30000,
  });
  await c.connect();
  const q = async (label: string, sql: string) => {
    const r = await c.query(sql);
    console.log(`\n── ${label}`);
    console.table(r.rows);
    return r.rows;
  };

  try {
    await q(
      "database size + the big tables",
      `SELECT pg_size_pretty(pg_database_size(current_database())) AS db_total,
              (SELECT pg_size_pretty(SUM(pg_total_relation_size(c.oid)))
                 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                WHERE n.nspname='public' AND c.relkind='r' AND c.relname LIKE 'jmdict%') AS jmdict,
              (SELECT pg_size_pretty(SUM(pg_total_relation_size(c.oid)))
                 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                WHERE n.nspname='public' AND c.relkind='r' AND c.relname LIKE 'wordnet%') AS wordnet,
              (SELECT pg_size_pretty(SUM(pg_total_relation_size(c.oid)))
                 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                WHERE n.nspname='public' AND c.relkind='r' AND c.relname LIKE '%embedding%') AS embeddings`,
    );

    await q(
      "per-user tables: total size + rows (the part that GROWS with users)",
      `SELECT c.relname AS table, pg_size_pretty(pg_total_relation_size(c.oid)) AS size,
              pg_total_relation_size(c.oid) AS bytes, n_live_tup AS rows,
              CASE WHEN n_live_tup > 0
                   THEN round(pg_total_relation_size(c.oid)::numeric / n_live_tup) END AS bytes_per_row
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
        WHERE n.nspname = 'public' AND c.relkind = 'r'
          AND c.relname IN ('users','user_words','lists','list_words','review_log',
                          'media_favorites','translation_usage','user_limits','words',
                          'account_deletion_log','error_log')
        ORDER BY pg_total_relation_size(c.oid) DESC`,
    );

    await q(
      "accounts",
      `SELECT COUNT(*)::int AS public_users,
              (SELECT COUNT(*)::int FROM auth.users) AS auth_users,
              (SELECT COUNT(*)::int FROM auth.users WHERE is_anonymous) AS anonymous,
              (SELECT COUNT(*)::int FROM auth.users WHERE email IS NOT NULL AND email <> '') AS with_email
         FROM public.users`,
    );

    await q(
      "footprint per user (who is actually using it)",
      `SELECT left(md5(u.user_id),8) AS bucket,
              (SELECT COUNT(*)::int FROM user_words w WHERE w.user_id=u.user_id) AS user_words,
              (SELECT COUNT(*)::int FROM review_log r JOIN user_words w2 ON w2.user_word_id=r.user_word_id
                WHERE w2.user_id=u.user_id) AS reviews,
              (SELECT COUNT(*)::int FROM lists l WHERE l.user_id=u.user_id) AS lists,
              (SELECT COALESCE(SUM(chars_used),0)::int FROM translation_usage t WHERE t.user_id=u.user_id) AS mt_chars_all_time,
              (SELECT MIN(a.created_at)::date FROM auth.users a WHERE a.id::text = u.user_id) AS created
         FROM public.users u
        ORDER BY user_words DESC NULLS LAST
        LIMIT 12`,
    );

    await q(
      "the heaviest user's activity SPAN (for a per-month rate)",
      `WITH top AS (
         SELECT user_id FROM user_words GROUP BY user_id ORDER BY COUNT(*) DESC LIMIT 1
       )
       SELECT (SELECT COUNT(*)::int FROM user_words WHERE user_id=(SELECT user_id FROM top)) AS words,
              (SELECT MIN(originally_translated_date)::date FROM user_words WHERE user_id=(SELECT user_id FROM top)) AS first_word,
              (SELECT MAX(originally_translated_date)::date FROM user_words WHERE user_id=(SELECT user_id FROM top)) AS last_word,
              (SELECT COUNT(*)::int FROM review_log r JOIN user_words w ON w.user_word_id=r.user_word_id
                WHERE w.user_id=(SELECT user_id FROM top)) AS reviews,
              (SELECT MIN(reviewed_at)::date FROM review_log r JOIN user_words w ON w.user_word_id=r.user_word_id
                WHERE w.user_id=(SELECT user_id FROM top)) AS first_review,
              (SELECT COUNT(DISTINCT reviewed_at::date)::int FROM review_log r JOIN user_words w ON w.user_word_id=r.user_word_id
                WHERE w.user_id=(SELECT user_id FROM top)) AS active_days`,
    );

    await q(
      "heaviest user PER CALENDAR MONTH — the per-user-month rate everything divides by",
      `WITH top AS (SELECT user_id FROM user_words GROUP BY user_id ORDER BY COUNT(*) DESC LIMIT 1)
       SELECT m.month,
              (SELECT COUNT(*)::int FROM user_words w
                WHERE w.user_id=(SELECT user_id FROM top)
                  AND to_char(w.originally_translated_date,'YYYY-MM')=m.month) AS words_saved,
              (SELECT COUNT(*)::int FROM review_log r JOIN user_words w ON w.user_word_id=r.user_word_id
                WHERE w.user_id=(SELECT user_id FROM top)
                  AND to_char(r.reviewed_at,'YYYY-MM')=m.month) AS reviews,
              (SELECT COUNT(DISTINCT r.reviewed_at::date)::int FROM review_log r JOIN user_words w ON w.user_word_id=r.user_word_id
                WHERE w.user_id=(SELECT user_id FROM top)
                  AND to_char(r.reviewed_at,'YYYY-MM')=m.month) AS active_days,
              (SELECT COALESCE(SUM(chars_used),0)::int FROM translation_usage t
                WHERE t.user_id=(SELECT user_id FROM top)
                  AND to_char(t.period_month,'YYYY-MM')=m.month) AS mt_chars
         FROM (SELECT DISTINCT to_char(originally_translated_date,'YYYY-MM') AS month
                 FROM user_words WHERE user_id=(SELECT user_id FROM top)) m
        ORDER BY m.month`,
    );

    await q(
      "review_log retention (bounds long-run per-user storage)",
      `SELECT pg_get_function_arguments(oid) AS prune_args,
              (SELECT max(n)::int FROM (SELECT COUNT(*) n FROM review_log GROUP BY user_word_id) s) AS max_per_word,
              (SELECT round(avg(n),1) FROM (SELECT COUNT(*) n FROM review_log GROUP BY user_word_id) s) AS avg_per_word,
              (SELECT string_agg(jobname || ' [' || schedule || ']', ', ') FROM cron.job WHERE active) AS active_cron
         FROM pg_proc WHERE proname = 'prune_review_log'`,
    );

    await q(
      "MT spend by month (all users) — the paid axis",
      `SELECT period_month, COUNT(*)::int AS users, SUM(chars_used)::int AS chars
         FROM translation_usage GROUP BY period_month ORDER BY period_month`,
    );

    await q(
      "words cache: shared, NOT per-user (grows with vocabulary breadth, then flattens)",
      `SELECT COUNT(*)::int AS rows,
              COUNT(*) FILTER (WHERE dictionary_ref LIKE 'mt:%')::int AS mt_rows,
              pg_size_pretty(pg_total_relation_size('public.words')) AS size
         FROM words`,
    );
  } finally {
    await c.end();
  }
}

void main();
