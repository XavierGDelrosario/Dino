// =========================================================
// MT usage monitor — live view of paid machine-translation (Google Cloud
// Translation) character spend, side by side across environments.
//
// MT usage is metered server-side into two service-only tables (both written by the
// edge function's reserve-before-call RPCs, so the numbers are the chars actually
// sent to Google, net of the failed-call refund in 20260628):
//   · global_translation_usage — the AGGREGATE per UTC month (the billing risk)
//   · translation_usage        — per user per UTC month (who is spending)
// Both are RLS-locked to the service role, so this reads them over a DIRECT Postgres
// connection (superuser bypasses RLS) — the same pattern as the ingest scripts.
//
// It resolves up to three environments and shows each (skipping any it can't reach):
//   · local    — LOCAL_DATABASE_URL, else the local Supabase (127.0.0.1:54322)
//   · staging  — STAGING_DATABASE_URL, else built from .env.deploy.staging
//   · prod     — PROD_DATABASE_URL,    else built from .env.deploy
// Hosted direct connections (db.<ref>.supabase.co) can be IPv6-only; if one is
// unreachable, pass the Session-pooler URL via the *_DATABASE_URL override.
//
// Usage:
//   npm run mt:usage              # one snapshot, all reachable envs
//   npm run mt:usage -- --watch   # live, refreshes every 10s (--watch=30 for 30s)
//   npm run mt:usage -- --month=2026-06   # a past UTC month
// =========================================================
import { readFileSync } from "node:fs";
import { Client } from "pg";

const DEFAULT_QUOTA = 2_000_000; // edge DEFAULT_GLOBAL_MONTHLY_CHAR_QUOTA (index.ts)
const LOCAL_DB = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

interface EnvSpec {
  name: string;
  url: string | null;
  /** Effective global quota (from the env file or the built-in default). */
  quota: number;
  quotaFromDefault: boolean;
}

/** Parse a KEY=VALUE dotenv-style file into a map (ignores comments/blank/`export`). */
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
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

/** Direct Postgres URL for a hosted Supabase project from its ref + db password. */
function hostedUrl(ref: string, password: string): string {
  return `postgresql://postgres:${encodeURIComponent(password)}@db.${ref}.supabase.co:5432/postgres`;
}

function resolveQuota(fileEnv: Record<string, string>): { quota: number; fromDefault: boolean } {
  const raw = process.env.GLOBAL_MONTHLY_CHAR_QUOTA ?? fileEnv.GLOBAL_MONTHLY_CHAR_QUOTA;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? { quota: n, fromDefault: false } : { quota: DEFAULT_QUOTA, fromDefault: true };
}

/** Direct URL from a deploy env file's ref + password, unless an override is set. */
function hostedFromFile(override: string | undefined, fileEnv: Record<string, string>): string | null {
  if (override) return override;
  return fileEnv.SUPABASE_PROJECT_REF && fileEnv.SUPABASE_DB_PASSWORD
    ? hostedUrl(fileEnv.SUPABASE_PROJECT_REF, fileEnv.SUPABASE_DB_PASSWORD)
    : null;
}

function spec(name: string, url: string | null, fileEnv: Record<string, string>): EnvSpec {
  const q = resolveQuota(fileEnv);
  return { name, url, quota: q.quota, quotaFromDefault: q.fromDefault };
}

/** Build the environment list from explicit overrides or the deploy env files. */
function resolveEnvs(): EnvSpec[] {
  const staging = readEnvFile(".env.deploy.staging");
  const prod = readEnvFile(".env.deploy");
  return [
    spec("local", process.env.LOCAL_DATABASE_URL ?? LOCAL_DB, readEnvFile("supabase/functions/.env")),
    spec("staging", hostedFromFile(process.env.STAGING_DATABASE_URL, staging), staging),
    spec("prod", hostedFromFile(process.env.PROD_DATABASE_URL, prod), prod),
  ];
}

interface Usage {
  global: number;
  userTotal: number;
  userCount: number;
  top: { bucket: string; chars: number }[];
}

const nf = (n: number) => n.toLocaleString("en-US");
const host = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return "?";
  }
};

/** Query one environment's MT usage for the given UTC month. */
async function queryUsage(url: string, month: string): Promise<Usage> {
  const client = new Client({
    connectionString: url,
    ssl: /\blocalhost\b|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false },
    connectionTimeoutMillis: 8000,
    statement_timeout: 8000,
  });
  await client.connect();
  try {
    const g = await client.query<{ chars_used: string }>(
      "SELECT chars_used FROM global_translation_usage WHERE period_month = $1",
      [month],
    );
    const agg = await client.query<{ total: string; users: string }>(
      "SELECT COALESCE(SUM(chars_used),0)::bigint AS total, COUNT(*)::int AS users FROM translation_usage WHERE period_month = $1",
      [month],
    );
    const top = await client.query<{ bucket: string; chars: string }>(
      "SELECT left(md5(user_id),8) AS bucket, chars_used AS chars FROM translation_usage WHERE period_month = $1 ORDER BY chars_used DESC LIMIT 3",
      [month],
    );
    return {
      global: Number(g.rows[0]?.chars_used ?? 0),
      userTotal: Number(agg.rows[0]?.total ?? 0),
      userCount: Number(agg.rows[0]?.users ?? 0),
      top: top.rows.map((r) => ({ bucket: r.bucket, chars: Number(r.chars) })),
    };
  } finally {
    await client.end();
  }
}

function renderEnv(env: EnvSpec, u: Usage): string {
  const pct = env.quota > 0 ? ((u.global / env.quota) * 100).toFixed(2) : "?";
  const quotaNote = env.quotaFromDefault ? " (default)" : "";
  const top = u.top.length
    ? u.top.map((t) => `${t.bucket}:${nf(t.chars)}`).join(" · ")
    : "—";
  return [
    `  ${env.name.toUpperCase().padEnd(8)} ${host(env.url!)}`,
    `    global   ${nf(u.global)} chars  (${pct}% of ${nf(env.quota)}${quotaNote})`,
    `    users    ${u.userCount} with spend · ${nf(u.userTotal)} chars total`,
    `    top      ${top}`,
  ].join("\n");
}

async function snapshot(envs: EnvSpec[], month: string): Promise<void> {
  const lines: string[] = [`MT usage — ${month} (UTC month)`, ""];
  for (const env of envs) {
    if (!env.url) {
      lines.push(`  ${env.name.toUpperCase().padEnd(8)} not configured (no *_DATABASE_URL / deploy env)`, "");
      continue;
    }
    try {
      const u = await queryUsage(env.url, month);
      lines.push(renderEnv(env, u), "");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      lines.push(
        `  ${env.name.toUpperCase().padEnd(8)} ${host(env.url)}`,
        `    unreachable: ${msg}`,
        `    (if hosted/IPv6, set ${env.name.toUpperCase()}_DATABASE_URL to the Session-pooler URL)`,
        "",
      );
    }
  }
  process.stdout.write(lines.join("\n") + "\n");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const monthArg = args.find((a) => a.startsWith("--month="))?.split("=")[1];
  const month = monthArg
    ? `${monthArg}-01`
    : new Date().toISOString().slice(0, 7) + "-01"; // first day of the current UTC month
  const watchArg = args.find((a) => a === "--watch" || a.startsWith("--watch="));
  const watchSecs = watchArg?.includes("=") ? Number(watchArg.split("=")[1]) : 10;

  const envs = resolveEnvs();

  if (!watchArg) {
    await snapshot(envs, month);
    return;
  }
  const period = Number.isFinite(watchSecs) && watchSecs >= 2 ? watchSecs : 10;
  // Live loop: clear + reprint each tick until Ctrl-C.
  for (;;) {
    process.stdout.write("\x1b[2J\x1b[H"); // clear screen + home cursor
    await snapshot(envs, month);
    process.stdout.write(`\n(live — every ${period}s · Ctrl-C to stop · ${new Date().toISOString()})\n`);
    await new Promise((r) => setTimeout(r, period * 1000));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
