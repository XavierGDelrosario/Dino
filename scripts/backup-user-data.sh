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
# Deliberately EXCLUDED (reproducible — rebuild via ingest/embed scripts, see §2):
#   words · jmdict_* · word_embeddings  (those are what dump-seed.sh captures).
# `review_log` is append-only FSRS training history and can never be backfilled —
# it is the single most important table here.
#
# Writes a timestamped, gitignored dump to backups/ (data-only, COPY format —
# loaded back by psql, which honors COPY; see restore-test.sh). Restore the
# schema first (migrations or a schema-only dump), then this file.
#
# Usage:
#   npm run db:backup                 # dump from the local stack -> backups/
#   BACKUP_DIR=/mnt/offsite npm run db:backup    # override destination
# Schedule it (cron / CI) and copy the output OFF the DB host.
# =========================================================
set -euo pipefail

CONTAINER="$(docker ps --filter name=supabase_db_ --format '{{.Names}}' | head -1)"
if [ -z "$CONTAINER" ]; then
  echo "error: no running supabase_db_* container found — start the stack first (supabase start)." >&2
  exit 1
fi

# The 7 user tables, in FK-safe order (parents before children) so a plain psql
# replay satisfies references even with triggers enabled.
TABLES=(
  public.users
  public.user_limits
  public.translation_usage
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

echo "[backup] dumping ${#TABLES[@]} user tables from $CONTAINER …"
docker exec "$CONTAINER" pg_dump -U postgres -d postgres \
  --data-only --no-owner --no-privileges "${ARGS[@]}" \
  > "$OUT"

SIZE="$(du -h "$OUT" | cut -f1)"
echo "[backup] wrote $OUT ($SIZE)."
echo "[backup] verify it restores:  npm run db:restore-test -- $OUT"
echo "[backup] COPY this file off the DB host (off-site) — it is gitignored."
