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
#   ./scripts/deploy-prod.sh supabase           # link + migrations+seed + edge fn + secrets
#   ./scripts/deploy-prod.sh frontend           # build against cloud + deploy to Pages
#   ./scripts/deploy-prod.sh lockdown <url>     # set ALLOWED_ORIGINS to the live Pages URL
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

  echo "==> [2/4] Applying migrations + loading dictionary seed (jmdict_* + embeddings)"
  echo "    (the seed is ~145MB over the wire — give it a few minutes)"
  sb db push --linked --include-seed -p "$SUPABASE_DB_PASSWORD" --yes

  echo "==> [3/4] Deploying edge functions (verify_jwt stays ON)"
  # --use-api bundles server-side (no local Docker required).
  sb functions deploy translate --use-api
  sb functions deploy delete-account --use-api

  echo "==> [4/4] Setting edge secrets"
  load_translation_key
  if [ -n "${TRANSLATION_API_KEY:-}" ]; then
    sb secrets set "TRANSLATION_API_KEY=$TRANSLATION_API_KEY"
    echo "    TRANSLATION_API_KEY set (MT fallback enabled)"
  else
    echo "    no TRANSLATION_API_KEY found — deploying JMdict-only (set it later to enable MT)"
  fi
  sb secrets set "GLOBAL_MONTHLY_CHAR_QUOTA=${GLOBAL_MONTHLY_CHAR_QUOTA:-5000000}"
  if [ -n "${ALLOWED_ORIGINS:-}" ]; then
    sb secrets set "ALLOWED_ORIGINS=$ALLOWED_ORIGINS"
    echo "    ALLOWED_ORIGINS=$ALLOWED_ORIGINS"
  else
    echo "    ALLOWED_ORIGINS not set yet → CORS open (*); run 'lockdown <url>' after the first Pages deploy"
  fi

  echo "==> Supabase phase done."
  echo "    Don't forget: dashboard → Authentication → URL Configuration →"
  echo "    set Site URL + add it to Redirect URLs (for password-reset links)."
}

resolve_anon_key() {
  require SUPABASE_PROJECT_REF "needed to fetch the anon key"
  if [ -n "${VITE_SUPABASE_ANON_KEY:-}" ]; then return; fi
  # Try the CLI; fall back to a clear instruction if the output format differs.
  VITE_SUPABASE_ANON_KEY="$(sb projects api-keys --project-ref "$SUPABASE_PROJECT_REF" -o json 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const a=JSON.parse(s);const k=a.find(x=>x.name==="anon");process.stdout.write(k?k.api_key:"")}catch{}})' || true)"
  if [ -z "$VITE_SUPABASE_ANON_KEY" ]; then
    echo "error: could not auto-fetch the anon key." >&2
    echo "  Grab it from dashboard → Settings → API → 'anon public', then re-run with:" >&2
    echo "  export VITE_SUPABASE_ANON_KEY='...'" >&2
    exit 1
  fi
}

deploy_frontend() {
  require SUPABASE_PROJECT_REF "needed to build VITE_SUPABASE_URL"
  require CF_PROJECT "your Cloudflare Pages project name (e.g. dino)"
  resolve_anon_key

  echo "==> Building frontend against https://$SUPABASE_PROJECT_REF.supabase.co"
  VITE_SUPABASE_URL="https://$SUPABASE_PROJECT_REF.supabase.co" \
  VITE_SUPABASE_ANON_KEY="$VITE_SUPABASE_ANON_KEY" \
    npm run build

  echo "==> Ensuring Cloudflare Pages project '$CF_PROJECT' exists"
  # Idempotent: only create when it's not already in the project list (re-creating
  # an existing project returns a generic API error, which we don't want to surface).
  if npx --no-install wrangler pages project list 2>/dev/null | grep -qw "$CF_PROJECT"; then
    echo "    '$CF_PROJECT' already exists — skipping create"
  else
    npx --no-install wrangler pages project create "$CF_PROJECT" --production-branch main
  fi

  echo "==> Deploying dist/ to Cloudflare Pages project '$CF_PROJECT'"
  echo "    (headless via CLOUDFLARE_API_TOKEN; no browser login needed)"
  npx --no-install wrangler pages deploy dist --project-name "$CF_PROJECT" --branch main

  echo "==> Frontend deployed. Copy the *.pages.dev URL it printed, then run:"
  echo "    ./scripts/deploy-prod.sh lockdown https://<your>.pages.dev"
}

lockdown() {
  local url="${1:-}"
  require SUPABASE_ACCESS_TOKEN "needed to set the secret"
  [ -n "$url" ] || { echo "usage: ./scripts/deploy-prod.sh lockdown https://<your>.pages.dev" >&2; exit 1; }
  echo "==> Locking CORS to $url"
  sb secrets set "ALLOWED_ORIGINS=$url"
  echo "    Done. Also set this URL as Site URL in dashboard → Authentication → URL Configuration."
}

case "${1:-}" in
  supabase)  deploy_supabase ;;
  frontend)  deploy_frontend ;;
  lockdown)  lockdown "${2:-}" ;;
  all)       deploy_supabase; deploy_frontend ;;
  *) echo "usage: $0 {supabase|frontend|lockdown <url>|all}" >&2; exit 1 ;;
esac
