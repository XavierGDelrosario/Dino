#!/usr/bin/env bash
# Build the PRODUCTION bundle, serve it, and run the browser E2E smoke test
# (scripts/e2e-smoke.mjs) against it. The smoke test mocks Supabase, so no backend
# is needed — this exercises the real Rollup build + real kuromoji in a browser,
# which is where prod-build-only bugs (e.g. the kuromoji gunzip hang) hide.
set -euo pipefail
cd "$(dirname "$0")/.."

# Dummy Supabase env so the bundle boots; the smoke test intercepts this host.
# MUST match SUPA_HOST in scripts/e2e-smoke.mjs.
export VITE_SUPABASE_URL="https://e2e.test.supabase.co"
export VITE_SUPABASE_ANON_KEY="eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.e2e"

echo "[e2e] building production bundle…"
npm run build

echo "[e2e] starting preview server…"
npx vite preview --port 4173 > /tmp/e2e-preview.log 2>&1 &
PREVIEW_PID=$!
trap 'kill "$PREVIEW_PID" 2>/dev/null || true' EXIT

for i in $(seq 1 30); do
  curl -s -o /dev/null "http://localhost:4173/" && break
  sleep 1
done

echo "[e2e] running smoke test…"
node scripts/e2e-smoke.mjs "http://localhost:4173"
