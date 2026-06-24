#!/usr/bin/env bash
# =========================================================
# Capture the loaded JMdict + word_embeddings data into a local seed file so
# `supabase db reset` restores the dictionary instantly — no re-ingest, no
# re-embed. Run this ONCE after a real ingest (npm run ingest:jmdict) and/or a
# re-embed (scripts/build-embeddings.py); thereafter every db reset auto-loads
# supabase/seeds/*.sql (configured in supabase/config.toml [db.seed]).
#
# The seed is data-only and gitignored (~120MB) — it is a regenerable cache of
# the JSON ingest, NOT source of truth.
#
# Usage: npm run db:dump-seed        (requires the local Supabase stack running)
# =========================================================
set -euo pipefail

CONTAINER="$(docker ps --filter name=supabase_db_ --format '{{.Names}}' | head -1)"
if [ -z "$CONTAINER" ]; then
  echo "error: no running supabase_db_* container found — start the stack first (supabase start)." >&2
  exit 1
fi

OUT="$(dirname "$0")/../supabase/seeds"
mkdir -p "$OUT"

echo "[dump-seed] dumping jmdict_* + word_embeddings from $CONTAINER …"
docker exec "$CONTAINER" pg_dump -U postgres -d postgres \
  --data-only --no-owner --no-privileges \
  -t public.jmdict_entries \
  -t public.jmdict_kanji \
  -t public.jmdict_kana \
  -t public.jmdict_senses \
  -t public.jmdict_glosses \
  -t public.word_embeddings \
  > "$OUT/jmdict_data.sql"

SIZE="$(du -h "$OUT/jmdict_data.sql" | cut -f1)"
echo "[dump-seed] wrote $OUT/jmdict_data.sql ($SIZE). It will auto-load on the next 'supabase db reset'."
