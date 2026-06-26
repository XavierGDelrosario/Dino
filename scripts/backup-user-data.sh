#!/usr/bin/env bash
# =========================================================
# Off-site logical export of the IRREPLACEABLE user-generated tables — the half
# of Launch-Checklist #6 (Backups + PITR) that lives in the repo. PITR itself is
# a hosted-Supabase toggle (gated on deploy, Tier-1 #4); this is the "keep an
# off-site export of the irreplaceable user tables on a schedule" + "test
# restores" ask from Production_Hardening.md §2.
#
# IRREPLACEABLE (user-generated, NOT reproducible from source releases):
#   users · user_words · lists · list_words · review_log · user_limits ·
#   translation_usage
# PLUS public.words (the dictionary CACHE): itself reproducible, BUT
# user_words.dictionary_word_id has an FK into it and the referenced cache rows
# are LAZILY projected (not guaranteed to exist after a fresh jmdict re-ingest),
# so the user-data dump is not referentially self-consistent without them. It is
# tiny (hundreds of rows), so we include it to keep the restore standalone.
# Deliberately EXCLUDED (reproducible AND large — rebuild via ingest/embed, §2):
#   jmdict_* · word_embeddings  (those are what dump-seed.sh captures).
# `review_log` is append-only FSRS training history and can never be backfilled —
# it is the single most important table here.
#
# Writes a timestamped, gitignored dump to backups/ (data-only, COPY format —
# loaded back by psql, which honors COPY; see restore-test.sh). Restore the
# schema first (migrations or a schema-only dump), then this file.
#
# Usage:
#   npm run db:backup                 # dump from the LOCAL stack -> backups/
#   BACKUP_DIR=/mnt/offsite npm run db:backup    # override destination
#   DATABASE_URL='postgresql://postgres:<pw>@db.<ref>.supabase.co:5432/postgres' \
#     npm run db:backup               # dump from HOSTED prod (Settings → Database)
# Schedule it (launchd / cron) and copy the output OFF the DB host.
#
# Source selection:
#   DATABASE_URL set  -> hosted prod. Uses a native `pg_dump` if one is on PATH
#                        (recommended for scheduled jobs: `brew install libpq`),
#                        else borrows the running supabase container's pg_dump
#                        (needs Docker up). pg_dump major >= server (Supabase PG15+).
#   DATABASE_URL unset-> the local supabase_db_* container (original behaviour).
# =========================================================
set -euo pipefail

# Resolve the dump source into a `dump()` function (args = pg_dump table flags).
if [ -n "${DATABASE_URL:-}" ]; then
  SOURCE_DESC="hosted DB (DATABASE_URL)"
  if command -v pg_dump >/dev/null 2>&1; then
    dump() { pg_dump "$DATABASE_URL" --data-only --no-owner --no-privileges "$@"; }
  else
    CONTAINER="$(docker ps --filter name=supabase_db_ --format '{{.Names}}' 2>/dev/null | head -1 || true)"
    if [ -z "$CONTAINER" ]; then
      echo "error: DATABASE_URL is set but no native pg_dump on PATH and no running supabase_db_* container to borrow one from." >&2
      echo "       Install the client (brew install libpq) or start the local stack (supabase start)." >&2
      exit 1
    fi
    echo "[backup] no native pg_dump — borrowing pg_dump from container $CONTAINER (Docker must stay up)." >&2
    dump() { docker exec "$CONTAINER" pg_dump "$DATABASE_URL" --data-only --no-owner --no-privileges "$@"; }
  fi
else
  CONTAINER="$(docker ps --filter name=supabase_db_ --format '{{.Names}}' 2>/dev/null | head -1 || true)"
  if [ -z "$CONTAINER" ]; then
    echo "error: no running supabase_db_* container found — start the stack first (supabase start), or set DATABASE_URL for a hosted backup." >&2
    exit 1
  fi
  SOURCE_DESC="$CONTAINER (local)"
  dump() { docker exec "$CONTAINER" pg_dump -U postgres -d postgres --data-only --no-owner --no-privileges "$@"; }
fi

# The user tables + the referenced dictionary cache, in FK-safe order (parents
# before children) so a plain psql replay satisfies references even with triggers
# enabled. public.words precedes user_words because user_words FKs into it.
TABLES=(
  public.users
  public.user_limits
  public.translation_usage
  public.words
  public.lists
  public.user_words
  public.list_words
  public.review_log
)

# UTC timestamp (matches the app's month-bucket convention) — sortable, tz-stable.
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="${BACKUP_DIR:-$(dirname "$0")/../backups}"
mkdir -p "$BACKUP_DIR"
OUT="$BACKUP_DIR/user-data-$STAMP.sql"

ARGS=(); for t in "${TABLES[@]}"; do ARGS+=( -t "$t" ); done

echo "[backup] dumping ${#TABLES[@]} user tables from $SOURCE_DESC …"
dump "${ARGS[@]}" > "$OUT"

SIZE="$(du -h "$OUT" | cut -f1)"
echo "[backup] wrote $OUT ($SIZE)."
echo "[backup] verify it restores:  npm run db:restore-test -- $OUT"
echo "[backup] COPY this file off the DB host (off-site) — it is gitignored."
