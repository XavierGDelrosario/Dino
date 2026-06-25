# Deploy runbook (#14)

First production deploy: **hosted Supabase (Free) + Cloudflare Pages**, common-JMdict.
Designed to upgrade cleanly to **Pro + full JMdict** later with no code change — just
re-ingest (see the last section).

The app is a static SPA (no router) that talks to a hosted Supabase project; the
`translate` edge function is the only backend code. The static host serves only the
bundle + `index.html` + the kuromoji dict (`/dict/*.gz`).

> Prereqs: a Supabase account, a Cloudflare account, the Supabase CLI logged in
> (`supabase login`), a `jmdict-eng-common-<ver>.json` release, and a Google Cloud
> Translation API key (for the MT fallback — optional; without it the app is
> JMdict-only).

## 1. Hosted Supabase (Free)
```bash
supabase login
supabase projects create dino           # or use an existing project ref
supabase link --project-ref <ref>

# Apply ALL migrations to the cloud DB (forward-only; never edit applied ones).
supabase db push

# Ingest the COMMON dict + frequency + embeddings into the CLOUD db (point the
# scripts at the cloud connection string from the dashboard: Settings → Database).
export DATABASE_URL='postgresql://postgres:<pw>@db.<ref>.supabase.co:5432/postgres'
npm run ingest:jmdict -- ./jmdict-eng-common-<ver>.json
# embeddings (one-time; needs the throwaway venv — see scripts/requirements-embeddings.txt)
/tmp/embvenv/bin/python scripts/build-embeddings.py        # default freq-floor policy
```
Free tier is 500 MB: common dict (~35 MB) + common embeddings (~80 MB) + app data
fits comfortably. (Full dict is ~243 MB → needs Pro; see upgrade section.)

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
# Build against the CLOUD project (anon key is public; RLS protects data).
VITE_SUPABASE_URL=https://<ref>.supabase.co \
VITE_SUPABASE_ANON_KEY=<anon-key> \
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

## 5. Upgrade path → Pro + full JMdict (later, no code change)
1. Upgrade the project to Pro (8 GB).
2. Re-ingest the FULL dict + re-embed against the cloud DB:
   ```bash
   npm run ingest:jmdict -- ./jmdict-eng-<ver>.json     # full ~217k entries
   /tmp/embvenv/bin/python scripts/build-embeddings.py
   ```
   The cache (`words`) re-projects lazily on lookup; bump `CURRENT_PROJECTION_VERSION`
   in the edge function if the projection logic changed (see CLAUDE.md #3).
3. Nothing else changes — same migrations, same frontend, same edge function.

## 6. Branch workflow (main is protected)
`main` = production and is **branch-protected**: no direct pushes; every change goes
**branch → PR → green CI → merge**. Required status checks: `quality`, `integration`,
`e2e` (must pass + branch up-to-date); enforced for admins too. Deploys still run from
`scripts/deploy-prod.sh` after a change lands on `main`.
