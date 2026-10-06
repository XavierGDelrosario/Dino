#!/usr/bin/env bash
# =============================================================================
# DINO production deploy — hosted Supabase + Cloudflare Pages.
# Companion to docs/Deploy.md. Run from your OWN terminal (it needs your
# Supabase access token + DB password + Cloudflare login). Nothing here is a
# secret in the file — all credentials come from the environment.
#
# Usage (run the phases in order):
#   export SUPABASE_ACCESS_TOKEN='sbp_...'      # account → Access Tokens
#   export SUPABASE_PROJECT_REF='abcd...'       # dashboard → Settings → General
#   export SUPABASE_DB_PASSWORD='...'           # the password you set on create
#   export CF_PROJECT='dino'                    # Cloudflare Pages project name
#
#   ./scripts/deploy-prod.sh supabase           # link + migrations + edge fns (routine, re-runnable)
#   FIRST_DEPLOY=1 ./scripts/deploy-prod.sh supabase   # ...plus the dictionary seed + secrets (new project only)
#   ./scripts/deploy-prod.sh frontend           # build against cloud + deploy to Pages
#   ./scripts/deploy-prod.sh lockdown <origins>  # REPLACE ALLOWED_ORIGINS (comma-separated list)
#   ./scripts/deploy-prod.sh captcha-on <secret> # Turnstile on the auth endpoints (sitekey'd bundle FIRST)
#   ./scripts/deploy-prod.sh captcha-off
#
# 'all' runs supabase then frontend (then lock down CORS manually once you have
# the final Pages URL — see step 4 / the 'lockdown' subcommand).
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

require() { # require VAR_NAME "human hint"
  local name="$1"
  if [ -z "${!name:-}" ]; then
    echo "error: \$$name is not set — $2" >&2
    exit 1
  fi
}

sb() { npx --no-install supabase "$@"; }

# Pull the real Google Translation key from the (gitignored) local edge env so we
# don't have to retype it. Override by exporting TRANSLATION_API_KEY yourself.
load_translation_key() {
  if [ -z "${TRANSLATION_API_KEY:-}" ] && [ -f supabase/functions/.env ]; then
    TRANSLATION_API_KEY="$(grep -iE '^TRANSLATION_API_KEY=' supabase/functions/.env \
      | head -1 | cut -d= -f2- | tr -d '"'"'"' ')"
  fi
}

deploy_supabase() {
  require SUPABASE_ACCESS_TOKEN "create one at supabase.com → account → Access Tokens"
  require SUPABASE_PROJECT_REF  "dashboard → Settings → General → Reference ID"
  require SUPABASE_DB_PASSWORD  "the database password you set when creating the project"

  echo "==> [1/4] Linking CLI to project $SUPABASE_PROJECT_REF"
  sb link --project-ref "$SUPABASE_PROJECT_REF" -p "$SUPABASE_DB_PASSWORD" --yes

  # ROUTINE vs FIRST deploy. Re-running this on a live project must change nothing but
  # the schema and the functions: the seed is a stale common-subset dump (prod runs the
  # full dictionary), and the secrets below would silently replace values set by hand.
  if [ "${FIRST_DEPLOY:-}" = "1" ]; then
    echo "==> [2/4] Applying migrations + loading dictionary seed (jmdict_* + embeddings)"
    echo "    (the seed is ~145MB over the wire — give it a few minutes)"
    sb db push --linked --include-seed -p "$SUPABASE_DB_PASSWORD" --yes
  else
    echo "==> [2/4] Applying migrations (no seed — FIRST_DEPLOY=1 loads it on a new project)"
    sb db push --linked -p "$SUPABASE_DB_PASSWORD" --yes
  fi

  echo "==> [3/4] Deploying edge functions (verify_jwt stays ON)"
  # --use-api bundles server-side (no local Docker required).
  sb functions deploy translate --use-api
  sb functions deploy delete-account --use-api

  echo "==> [4/4] Edge secrets"
  # Only what was EXPLICITLY exported is written, so a routine deploy can't replace a
  # live secret. A first deploy may also pick the MT key up from the local edge env.
  [ "${FIRST_DEPLOY:-}" = "1" ] && load_translation_key
  if [ -n "${TRANSLATION_API_KEY:-}" ]; then
    sb secrets set "TRANSLATION_API_KEY=$TRANSLATION_API_KEY"
    echo "    TRANSLATION_API_KEY set (MT fallback enabled)"
  else
    echo "    TRANSLATION_API_KEY left as it is on the project"
  fi
  # Unset on the project = the edge's built-in 2,000,000 chars/month. This used to force
  # 5,000,000 on every run, 2.5x the cap the cost reasoning in the docs assumes.
  if [ -n "${GLOBAL_MONTHLY_CHAR_QUOTA:-}" ]; then
    sb secrets set "GLOBAL_MONTHLY_CHAR_QUOTA=$GLOBAL_MONTHLY_CHAR_QUOTA"
    echo "    GLOBAL_MONTHLY_CHAR_QUOTA=$GLOBAL_MONTHLY_CHAR_QUOTA"
  else
    echo "    GLOBAL_MONTHLY_CHAR_QUOTA left as it is on the project"
  fi
  if [ -n "${ALLOWED_ORIGINS:-}" ]; then
    sb secrets set "ALLOWED_ORIGINS=$ALLOWED_ORIGINS"
    echo "    ALLOWED_ORIGINS=$ALLOWED_ORIGINS"
  else
    echo "    ALLOWED_ORIGINS left as it is on the project (unset = the edge refuses every origin)"
  fi

  echo "==> Supabase phase done."
  echo "    Don't forget: dashboard → Authentication → URL Configuration →"
  echo "    set Site URL + add it to Redirect URLs (for password-reset links)."
}

resolve_anon_key() {
  require SUPABASE_PROJECT_REF "needed to fetch the publishable key"
  if [ -n "${VITE_SUPABASE_ANON_KEY:-}" ]; then return; fi
  # MUST be the PUBLISHABLE key (sb_publishable_…), NOT the legacy `anon` JWT — the
  # legacy keys are DISABLED in prod, so a bundle built with the anon JWT can't
  # authenticate and the app is dead on load (see docs/Deploy.md §6). Select by
  # type=="publishable" (matches scripts/build-ios.sh), never by name=="anon".
  VITE_SUPABASE_ANON_KEY="$(sb projects api-keys --project-ref "$SUPABASE_PROJECT_REF" -o json 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const p=JSON.parse(s);const a=Array.isArray(p)?p:(p.keys||[]);const k=a.find(x=>x.type==="publishable");process.stdout.write(k?k.api_key:"")}catch{}})' || true)"
  if [ -z "$VITE_SUPABASE_ANON_KEY" ]; then
    echo "error: could not auto-fetch the PUBLISHABLE key." >&2
    echo "  Grab it from dashboard → Settings → API keys → 'default' publishable (sb_publishable_…)," >&2
    echo "  then re-run with:  export VITE_SUPABASE_ANON_KEY='sb_publishable_...'" >&2
    exit 1
  fi
  case "$VITE_SUPABASE_ANON_KEY" in
    sb_publishable_*) : ;;
    *) echo "error: resolved key is not a publishable key (got '${VITE_SUPABASE_ANON_KEY:0:12}…')." >&2
       echo "  Refusing to build with a legacy anon JWT — it's disabled in prod (docs/Deploy.md §6)." >&2
       echo "  Export the publishable key explicitly: export VITE_SUPABASE_ANON_KEY='sb_publishable_...'" >&2
       exit 1 ;;
  esac
}

# Production ships what is on origin/main and nothing else: no feature branch, no
# uncommitted edit to a tracked file. Untracked files don't reach the bundle and are
# ignored. ALLOW_UNMERGED=1 overrides, for a deliberate hotfix.
require_main() {
  [ "${ALLOW_UNMERGED:-}" = "1" ] && { echo "    (ALLOW_UNMERGED=1 — skipping the main-branch check)"; return; }
  local branch
  branch="$(git rev-parse --abbrev-ref HEAD)"
  if [ "$branch" != "main" ]; then
    echo "error: on branch '$branch' — production deploys from main (ALLOW_UNMERGED=1 to override)." >&2; exit 1
  fi
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    echo "error: tracked files have uncommitted changes — commit or stash them first." >&2; exit 1
  fi
  git fetch -q origin main
  if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
    echo "error: HEAD is not origin/main — pull (or push) first so the deploy matches a reviewed commit." >&2; exit 1
  fi
  echo "    deploying main @ $(git rev-parse --short HEAD)"
}

deploy_frontend() {
  require SUPABASE_PROJECT_REF "needed to build VITE_SUPABASE_URL"
  require_main
  require CF_PROJECT "your Cloudflare Pages project name (e.g. dino)"
  resolve_anon_key

  echo "==> Building frontend against https://$SUPABASE_PROJECT_REF.supabase.co"
  VITE_SUPABASE_URL="https://$SUPABASE_PROJECT_REF.supabase.co" \
  VITE_SUPABASE_ANON_KEY="$VITE_SUPABASE_ANON_KEY" \
  VITE_GOOGLE_CLIENT_ID="${VITE_GOOGLE_CLIENT_ID:-${GOOGLE_OAUTH_CLIENT_ID:-}}" \
  VITE_TURNSTILE_SITE_KEY="${VITE_TURNSTILE_SITE_KEY:-}" \
    npm run build
  # ^ The Turnstile sitekey (CAPTCHA on the auth endpoints, services/captcha.ts) rides in
  #   from .env.deploy when set; unset = the client mints no token, today's behaviour.
  #   ORDER MATTERS: ship a bundle WITH the sitekey first, then `captcha-on` — enabling
  #   the project setting against a bundle without a key locks every visitor out.
  #   build-ios.sh deliberately passes none: Turnstile can't run under capacitor://.

  echo "==> Ensuring Cloudflare Pages project '$CF_PROJECT' exists"
  # Idempotent: only create when it's not already in the project list (re-creating
  # an existing project returns a generic API error, which we don't want to surface).
  if npx -y wrangler@4.104.0 pages project list 2>/dev/null | grep -qw "$CF_PROJECT"; then
    echo "    '$CF_PROJECT' already exists — skipping create"
  else
    npx -y wrangler@4.104.0 pages project create "$CF_PROJECT" --production-branch main
  fi

  echo "==> Deploying dist/ to Cloudflare Pages project '$CF_PROJECT'"
  echo "    (headless via CLOUDFLARE_API_TOKEN; no browser login needed)"
  npx -y wrangler@4.104.0 pages deploy dist --project-name "$CF_PROJECT" --branch main

  echo "==> Frontend deployed (live at https://dinostudy.com)."
}

# CAPTCHA (Cloudflare Turnstile) on the project's auth endpoints — anonymous sign-in,
# password sign-in, password reset. The hosted toggle lives in the auth config; this
# flips it over the Management API so the rollback is the same command with `off`.
#   ./scripts/deploy-prod.sh captcha-on <turnstile-secret>   # AFTER a sitekey'd bundle is live
#   ./scripts/deploy-prod.sh captcha-off
# ⚠️ A native build pointed at this project loses guest sign-in while this is on
#    (Turnstile does not run under capacitor://) — point dev devices at staging first.
captcha() {
  local mode="${1:-}" secret="${2:-}"
  require SUPABASE_ACCESS_TOKEN "needed to change the auth config"
  require SUPABASE_PROJECT_REF "which project"
  local body
  case "$mode" in
    on)
      [ -n "$secret" ] || { echo "usage: ./scripts/deploy-prod.sh captcha-on <turnstile-secret>" >&2; exit 1; }
      body="{\"security_captcha_enabled\":true,\"security_captcha_provider\":\"turnstile\",\"security_captcha_secret\":\"$secret\"}" ;;
    off)
      body='{"security_captcha_enabled":false}' ;;
    *) echo "usage: captcha-on <secret> | captcha-off" >&2; exit 1 ;;
  esac
  echo "==> CAPTCHA $mode on $SUPABASE_PROJECT_REF"
  curl -sS -X PATCH "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/config/auth" \
    -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H "Content-Type: application/json" \
    -d "$body" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const c=JSON.parse(s);console.log("    captcha:",c.security_captcha_enabled,"provider:",c.security_captcha_provider)})'
}

lockdown() {
  local url="${1:-}"
  require SUPABASE_ACCESS_TOKEN "needed to set the secret"
  # This REPLACES the whole list: leave out capacitor://localhost and the iOS app
  # can no longer reach the edge function.
  [ -n "$url" ] || { echo "usage: ./scripts/deploy-prod.sh lockdown https://dinostudy.com,capacitor://localhost" >&2; exit 1; }
  echo "==> Setting ALLOWED_ORIGINS to $url"
  sb secrets set "ALLOWED_ORIGINS=$url"
  echo "    Done. Site URL lives in dashboard → Authentication → URL Configuration."
  echo
  echo "    Verify CORS + the live invoke path (preflight + authed POST), e.g.:"
  echo "      VITE_SUPABASE_URL=https://\$SUPABASE_PROJECT_REF.supabase.co \\"
  echo "      VITE_SUPABASE_ANON_KEY=<anon> npm run smoke:prod -- https://dinostudy.com"
}

case "${1:-}" in
  supabase)  deploy_supabase ;;
  frontend)  deploy_frontend ;;
  captcha-on)  captcha on "${2:-}" ;;
  captcha-off) captcha off ;;
  lockdown)  lockdown "${2:-}" ;;
  all)       deploy_supabase; deploy_frontend ;;
  *) echo "usage: $0 {supabase|frontend|lockdown <url>|all}" >&2; exit 1 ;;
esac
