#!/usr/bin/env bash
# =========================================================
# Prove a user-data backup actually restores — "an untested backup is a
# hypothesis" (Production_Hardening.md §2). Restores a dump from
# backup-user-data.sh into a throwaway scratch database in the SAME local
# Postgres container, then asserts every user table's row count matches the
# live source. Exits non-zero on any mismatch or load error.
#
# It builds the scratch schema from a live schema-only pg_dump (not the
# migration files) so the test exercises the schema as it actually runs — no
# migration-drift blind spot.
#
# Usage:
#   npm run db:restore-test                       # backs up live, restores, verifies
#   npm run db:restore-test -- backups/user-data-<stamp>.sql   # verify an existing dump
#   KEEP_SCRATCH=1 npm run db:restore-test        # leave the scratch DB for inspection
#   DATABASE_URL='postgresql://…@db.<ref>.supabase.co:5432/postgres' \
#     npm run db:restore-test                     # verify a HOSTED-prod backup
#
# The scratch sandbox is ALWAYS the local supabase_db_* container (you can't
# CREATE DATABASE on hosted Supabase), so the local stack must be running even
# when verifying a hosted backup. With DATABASE_URL set, the "live" side that the
# restored scratch is compared against (schema + row counts) is the hosted DB,
# reached via the container's own pg_dump/psql pointed at the URL.
# =========================================================
set -euo pipefail

CONTAINER="$(docker ps --filter name=supabase_db_ --format '{{.Names}}' 2>/dev/null | head -1 || true)"
if [ -z "$CONTAINER" ]; then
  echo "error: no running supabase_db_* container found — start the stack first (supabase start). The scratch sandbox is always local, even when verifying a hosted backup." >&2
  exit 1
fi

HERE="$(dirname "$0")"
SCRATCH="dino_restore_test"
TABLES=(users user_limits translation_usage words lists user_words list_words review_log)

# Scratch-sandbox ops — ALWAYS the local container.
psql() { docker exec -i "$CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 "$@"; }
count() { psql -d "$1" -tAc "SELECT count(*) FROM public.$2"; }

# "Live" source (compared against the restored scratch) — hosted or local.
if [ -n "${DATABASE_URL:-}" ]; then
  LIVE_DESC="hosted DB (DATABASE_URL)"
  live_schema_dump() { docker exec "$CONTAINER" pg_dump "$DATABASE_URL" --schema-only --no-owner --no-privileges -n public; }
  live_count() { docker exec -i "$CONTAINER" psql "$DATABASE_URL" -tAc "SELECT count(*) FROM public.$1"; }
else
  LIVE_DESC="$CONTAINER (local)"
  live_schema_dump() { docker exec "$CONTAINER" pg_dump -U postgres -d postgres --schema-only --no-owner --no-privileges -n public; }
  live_count() { count postgres "$1"; }
fi

# 1. Get a dump to test — either the one passed in, or a fresh one of live data.
DUMP="${1:-}"
if [ -n "$DUMP" ]; then
  [ -f "$DUMP" ] || { echo "error: dump file not found: $DUMP" >&2; exit 1; }
  echo "[restore-test] verifying existing dump: $DUMP"
else
  echo "[restore-test] no dump given — taking a fresh backup of live data first."
  bash "$HERE/backup-user-data.sh"
  DUMP="$(ls -t "$HERE/../backups/"user-data-*.sql | head -1)"
  echo "[restore-test] testing freshest backup: $DUMP"
fi

# 2. Rebuild the scratch DB and clone the live public schema (schema only).
echo "[restore-test] (re)creating scratch database '$SCRATCH' …"
psql -d postgres -c "DROP DATABASE IF EXISTS $SCRATCH" >/dev/null
psql -d postgres -c "CREATE DATABASE $SCRATCH" >/dev/null

# The public schema references things that live OUTSIDE a -n public dump: the
# `vector`/`pg_trgm` extension types (as public.vector / public.gin_trgm_ops) and
# auth.uid() (Supabase's auth schema). Pre-create minimal stand-ins so the schema
# loads cleanly. RLS itself is irrelevant to the test — we read as the table owner
# (bypassing RLS) and only count rows — but the CREATE POLICY statements still need
# auth.uid() to resolve.
psql -d "$SCRATCH" >/dev/null <<'STUB'
CREATE EXTENSION IF NOT EXISTS vector  WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS 'SELECT NULL::uuid';
STUB

echo "[restore-test] cloning live schema (schema-only) from $LIVE_DESC into scratch …"
# -n public keeps out other schemas' objects (some carry SET log_min_messages the
# postgres role can't set). Drop the dump's own `CREATE SCHEMA public;` — scratch
# already has it (and the pre-created extensions live in it). Strip the psql-only
# \restrict meta-commands pg_dump 17 emits.
live_schema_dump \
  | grep -vE '^\\(un)?restrict' \
  | grep -vxF 'CREATE SCHEMA public;' \
  | psql -d "$SCRATCH" >/dev/null

# Guard against silent partial schema load — every user table must exist before
# we trust a row-count comparison (a missing table would otherwise read as 0 = 0).
for t in "${TABLES[@]}"; do
  psql -d "$SCRATCH" -tAc "SELECT 'public.$t'::regclass" >/dev/null \
    || { echo "[restore-test] FAILED — table public.$t did not load into scratch." >&2; exit 1; }
done

# 3. Load the backup into scratch.
echo "[restore-test] loading backup into scratch …"
psql -d "$SCRATCH" < "$DUMP" >/dev/null

# 4. Verify: every user table's scratch count equals the live count.
echo "[restore-test] comparing row counts ($LIVE_DESC vs restored) …"
FAIL=0
printf '  %-22s %10s %10s\n' table live restored
for t in "${TABLES[@]}"; do
  LIVE="$(live_count "$t")"
  REST="$(count "$SCRATCH" "$t")"
  MARK="ok"
  if [ "$LIVE" != "$REST" ]; then MARK="MISMATCH"; FAIL=1; fi
  printf '  %-22s %10s %10s  %s\n' "$t" "$LIVE" "$REST" "$MARK"
done

# 5. Clean up (unless asked to keep it).
if [ "${KEEP_SCRATCH:-0}" = "1" ]; then
  echo "[restore-test] KEEP_SCRATCH=1 — leaving scratch DB '$SCRATCH' in place."
else
  psql -d postgres -c "DROP DATABASE IF EXISTS $SCRATCH" >/dev/null
fi

if [ "$FAIL" = "1" ]; then
  echo "[restore-test] FAILED — restored row counts do not match live. Backup is NOT trustworthy." >&2
  exit 1
fi
echo "[restore-test] PASS — backup restores cleanly, all row counts match."
