#!/usr/bin/env bash
# Build the web app against the PROD backend (so a dev phone can reach Supabase +
# the edge function — a phone can't hit local 127.0.0.1) and sync it into the iOS
# project. Run `npx cap add ios` ONCE first (needs Xcode + CocoaPods).
#
# The publishable key is public; pulled from the gitignored .env.deploy like the
# Cloudflare deploy. No secrets are baked beyond that public key.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ ! -f .env.deploy ]]; then
  echo "✗ .env.deploy not found — needed for the prod Supabase ref + access token." >&2
  exit 1
fi
set -a; source .env.deploy; set +a
export SUPABASE_ACCESS_TOKEN

# raw_decode parses just the leading JSON value — tolerant of a trailing line the
# CLI appends to stdout (a PostHog shutdown error, or an update notice). The `|| true`
# stops `set -e`/pipefail aborting the script when the CLI exits non-zero despite
# having printed the key; the empty-check below is the real guard.
PUB=$(./node_modules/.bin/supabase projects api-keys --project-ref "$SUPABASE_PROJECT_REF" 2>/dev/null \
  | python3 -c "import sys,json; d=json.JSONDecoder().raw_decode(sys.stdin.read().lstrip())[0]; print(next(k['api_key'] for k in d['keys'] if k.get('type')=='publishable'))" 2>/dev/null || true)
if [[ -z "${PUB:-}" ]]; then echo "✗ could not resolve the prod publishable key" >&2; exit 1; fi

echo "→ building web app against prod (https://${SUPABASE_PROJECT_REF}.supabase.co)…"
VITE_SUPABASE_URL="https://${SUPABASE_PROJECT_REF}.supabase.co" VITE_SUPABASE_ANON_KEY="$PUB" npm run build

if [[ -d ios ]]; then
  echo "→ syncing into ios/…"
  ./node_modules/.bin/cap sync ios
  echo "✓ built + synced. Open Xcode with: npm run ios:open"
else
  echo "⚠ ios/ not found — run \`npx cap add ios\` first (needs Xcode + CocoaPods), then re-run."
fi
