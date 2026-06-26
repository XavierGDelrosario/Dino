#!/usr/bin/env bash
# Start the local Supabase stack WITH Google OAuth enabled.
#
# Why this exists: config.toml's [auth.external.google] uses env() substitution
# (SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID / _SECRET), resolved by the CLI from the
# process environment at `supabase start` time. A plain `supabase start` leaves them
# unset, so "Continue with Google" dies locally. This maps the creds from the
# gitignored .env.deploy (named GOOGLE_OAUTH_CLIENT_ID / _SECRET there) into the
# names the CLI expects, then starts.
#
# Contains NO secrets itself (reads them from .env.deploy) — safe to commit.
# If .env.deploy is missing or lacks the creds, it still starts; Google sign-in is
# just disabled (everything else works).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ENV_DEPLOY="$ROOT/.env.deploy"

# Prefer the project-local CLI; fall back to one on PATH.
if [[ -x "$ROOT/node_modules/.bin/supabase" ]]; then
  SUPABASE="$ROOT/node_modules/.bin/supabase"
else
  SUPABASE="supabase"
fi

# Read a single KEY=value from .env.deploy, stripping optional surrounding quotes.
read_env() {
  local key="$1"
  [[ -f "$ENV_DEPLOY" ]] || return 0
  sed -n "s/^${key}=//p" "$ENV_DEPLOY" | head -n1 | sed -e 's/^["'\'']//' -e 's/["'\'']$//'
}

CLIENT_ID="$(read_env GOOGLE_OAUTH_CLIENT_ID)"
CLIENT_SECRET="$(read_env GOOGLE_OAUTH_CLIENT_SECRET)"

if [[ -n "$CLIENT_ID" && -n "$CLIENT_SECRET" ]]; then
  export SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID="$CLIENT_ID"
  export SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET="$CLIENT_SECRET"
  echo "✓ Google OAuth creds loaded from .env.deploy (client_id …${CLIENT_ID: -8})"
else
  echo "⚠ Google OAuth creds not found in .env.deploy — starting WITHOUT Google sign-in."
  echo "  (config.toml has [auth.external.google] enabled = true; it needs these env vars."
  echo "   Add GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET to .env.deploy.)"
fi

exec "$SUPABASE" start "$@"
