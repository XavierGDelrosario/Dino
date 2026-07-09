# Deploy runbook (#14)

**Currently LIVE on Free:** prod (`sslzipicrbkjbeyszghi`) + a separate staging project
(`jfcbhxgqxzpfxztlkawt`, see §8), both on **hosted Supabase (Free) + Cloudflare Pages**,
running the **FULL JMdict** (~243 MB — it fits the 500 MB Free tier with headroom; Pro is
NOT needed for the dictionary, only for bigger embeddings / backups / a custom auth domain —
see §5). Day-to-day deploys go through `scripts/deploy-prod.sh`; this doc is the from-scratch
setup for a NEW environment.

The app is a static SPA (no router) that talks to a hosted Supabase project; the
`translate` edge function is the only backend code. The static host serves only the
bundle + `index.html` + the kuromoji dict (`/dict/*.gz`).

> Prereqs: a Supabase account, a Cloudflare account, the Supabase CLI logged in
> (`supabase login`), a `jmdict-eng-<ver>.json` release (the FULL edition; the
> `-common-` subset works for a lean dev env), the WordNet + CEFR/frequency source
> files (see the ingest steps in §1), and a Google Cloud Translation API key (for the
> MT fallback — optional; without it the app is JMdict-only).

## 1. Hosted Supabase (Free)
```bash
supabase login
supabase projects create dino           # or use an existing project ref
supabase link --project-ref <ref>

# Apply ALL migrations to the cloud DB (forward-only; never edit applied ones).
supabase db push

# Ingest the data pipelines into the CLOUD db (point every script at the cloud
# connection string from the dashboard: Settings → Database). Order matters where noted.
export DATABASE_URL='postgresql://postgres:<pw>@db.<ref>.supabase.co:5432/postgres'

# 1. JMdict (the dictionary). The ingest JOINS data/frequency/ja.tsv (wordfreq) AND
#    data/proficiency/ja.tsv (JLPT) onto the jmdict tables automatically, so JA
#    frequency + JLPT bands are populated by this one step.
npm run ingest:jmdict -- ./jmdict-eng-<ver>.json           # FULL ~217k entries (fits Free)

# 2. Japanese WordNet (semantic EN→JA). AFTER JMdict (resolves JA lemmas against it).
npm run ingest:wordnet -- ./wnjpn.db ./wnjpn-ok.tab

# 3. English leveling (EN-source difficulty + CEFR). Server-only tables the edge reads
#    when projecting EN→JA; NOT in the seed, so a new env MUST run these.
npm run ingest:english-frequency      # data/frequency/en.tsv  (wordfreq EN, committed)
npm run ingest:english-proficiency    # data/proficiency/en.tsv (CEFR-J + Octanove, committed)

# 4. Embeddings / word-map (#11; one-time; needs the throwaway venv — see
#    scripts/requirements-embeddings.txt). Common-only fits Free; full-dict / bigger
#    model is the Free→Pro trigger (see §5).
/tmp/embvenv/bin/python scripts/build-embeddings.py --common-only
```
Free tier is 500 MB and the FULL dict (~243 MB) + common-only embeddings (~80 MB) + the
english_* + wordnet tables + app data still fit (~180 MB headroom). The dictionary does
NOT need Pro — only the bigger word-map does (§5).

## 2. Edge function + secrets
```bash
supabase functions deploy translate

supabase secrets set TRANSLATION_API_KEY=<google-key>        # enables MT fallback
supabase secrets set ALLOWED_ORIGINS=https://<your-pages-domain>   # CORS allow-list
# Cost controls (#1) — optional but recommended before public:
supabase secrets set GLOBAL_MONTHLY_CHAR_QUOTA=<aggregate-cap>     # e.g. 5000000
#   (MT_DISABLED=1 is the emergency kill-switch — set it to stop all paid calls.)
# Optional per-request / per-user defaults: PARAGRAPH_CHAR_LIMIT, MONTHLY_CHAR_QUOTA.
```
`verify_jwt` is ON by default for deployed functions (do NOT pass --no-verify-jwt).

**Auth URL config (for password-reset / magic links):** in the dashboard →
Authentication → URL Configuration, set **Site URL** to the Pages domain and add it
to **Redirect URLs**. Locally this is `config.toml` `site_url` /
`additional_redirect_urls` (already `localhost:5173`). Without it, reset links bounce
to the wrong origin. Consider enabling email confirmations in prod (local has them
off) — the upgrade/reset code already round-trips through email.

## 3. Frontend → Cloudflare Pages
```bash
# Build against the CLOUD project. Use the PUBLISHABLE key (sb_publishable_…), NOT
# the legacy anon JWT — legacy API keys are DISABLED on this project (key-rotation
# remediation; see §6). The publishable key is public; RLS protects data.
VITE_SUPABASE_URL=https://<ref>.supabase.co \
VITE_SUPABASE_ANON_KEY=sb_publishable_… \
npm run build
```
Deploy `dist/` to Cloudflare Pages (dashboard "Direct Upload", or
`npx wrangler pages deploy dist`). Build settings if using Git integration:
- Build command: `npm run build`
- Output dir: `dist`
- Env vars: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`.

`public/_headers` (copied into `dist/`) serves `/dict/*.gz` as `application/octet-stream`
so kuromoji's own gunzip works — the prod equivalent of the dev `serveDictRaw` plugin.
(Same file works on Netlify; for Vercel, port those rules to `vercel.json` headers.)

## 4. Post-deploy verification
- Open the Pages URL → Translate a Japanese sentence (kuromoji segments → no
  "invalid file signature" console error = `/dict` headers are correct).
- Confirm CORS: the browser calls `…supabase.co/functions/v1/translate` with no CORS
  error (ALLOWED_ORIGINS matches the Pages domain).
- Hit `GET …/functions/v1/translate` → `{status:"ok"}` (health check, #8).
- Restrict the Google API key to the function's egress / referrers (Tier 2).

## 5. When Pro is actually needed (NOT for the dictionary)
The full dict already runs on Free (§1). Pro (8 GB, $25/mo) is the trigger only for:
- **Bigger / fuller embeddings** — `build-embeddings.py` without `--common-only` (deeper
  freq-floor) and/or the 1024-dim `multilingual-e5-large` model (fixes the katakana-loanword
  clustering bug, `docs/QualityLimitations.md`). ~415 MB at 1024-dim blows the Free cap.
- **Automated backups + PITR** — a dashboard toggle (Free has none; interim = `db:backup`).
- **Custom auth domain** (`auth.<domain>`) for branded Google consent (§ launch polish).

Re-ingesting / re-embedding needs no code change — same migrations, frontend, edge function.
The cache (`words`) re-projects lazily on lookup; **bump `CURRENT_PROJECTION_VERSION`** in the
edge function whenever the projection DATA or logic changes (currently **6**), so the deferred
re-projection sweep can find stale rows (CLAUDE.md #3).

## 6. Branch workflow (main is protected)
`main` = production and is **branch-protected**: no direct pushes; every change goes
**branch → PR → green CI → merge**. Required status checks: `quality`, `integration`,
`e2e` (must pass + branch up-to-date); enforced for admins too. Deploys still run from
`scripts/deploy-prod.sh` after a change lands on `main`.

## 7. API keys — new key system (legacy DISABLED)
The project uses Supabase's **new API keys** (asymmetric JWT signing); the **legacy
`anon` / `service_role` JWTs are disabled** (`GET /v1/projects/<ref>/api-keys/legacy`
→ `{"enabled":false}`). This was a key-rotation remediation after a legacy
`service_role` key leaked. Consequences for deploys:
- **Frontend** builds with `VITE_SUPABASE_ANON_KEY=sb_publishable_…` (the publishable
  key), not the legacy anon JWT (§3). A build with the old anon key produces a
  broken app (every request 401s).
- **Edge function** authenticates with the **secret key** via the `SERVICE_ROLE_SECRET`
  edge secret (set with `sb_secret_…`). `index.ts` prefers it over the auto-injected
  legacy `SUPABASE_SERVICE_ROLE_KEY` (which is now disabled), so the function keeps
  full RLS-bypass access. If you ever re-enable legacy keys, the fallback still works.
- To **rotate again**: roll the `sb_secret_…` key in the dashboard (or
  `POST /v1/projects/<ref>/api-keys`), update the `SERVICE_ROLE_SECRET` edge secret,
  redeploy the function; roll `sb_publishable_…` similarly + rebuild/redeploy the FE.

## 8. Staging environment (`jfcbhxgqxzpfxztlkawt`)
A **separate, isolated Free project** used for iOS dev-device builds + risky changes, set
up identically to prod (§1–§2: migrations + all ingests + edge). It's the safe test bed —
every migration/edge change this session went **staging → verify → prod**.
- **Env files:** prod = `.env.deploy` (ref `sslz…`), staging = `.env.deploy.staging`
  (ref `jfcb…`). Each holds `SUPABASE_PROJECT_REF` + `SUPABASE_DB_PASSWORD` + the access
  token; deploy scripts pick the file by `DINO_ENV`.
- **iOS build:** `npm run ios:build` targets PROD; `npm run ios:build:staging`
  (`DINO_ENV=staging bash scripts/build-ios.sh`) targets staging. A dev *device* can't reach
  the Mac's `127.0.0.1`, so on-device builds MUST point at a hosted project.
- **`ALLOWED_ORIGINS` differs by env:** native reaches the edge via `capacitor://localhost`;
  local web dev via `http://localhost:5173`. Staging is set to both
  (`capacitor://localhost,http://localhost:5173`) so `npm run dev` can point at staging.
- **Deploying a change to both:** for each env file, `source` it, then
  `supabase link --project-ref $SUPABASE_PROJECT_REF --password $SUPABASE_DB_PASSWORD`,
  `supabase db push`, run any new ingest, `supabase functions deploy translate`. Verify on
  staging first. (The English/proficiency tables aren't in the seed — re-run their ingests
  per environment; see CLAUDE.md.)
