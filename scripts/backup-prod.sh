#!/usr/bin/env bash
# =========================================================
# Scheduled off-host backup of HOSTED-prod user data — the launchd/cron wrapper
# around `db:backup` (scripts/backup-user-data.sh). Interim durability while the
# project is on the Supabase FREE tier (no hosted automated backups / PITR — that
# is a Pro toggle, Launch-Checklist #6). Runs the dump, encrypts it, copies it
# off this machine, and prunes the local staging dir.
#
# Secrets live OUTSIDE the repo. Read config from a gitignored env file (gitleaks
# CI scans full history, so NEVER hardcode the connection string here). Default
# ~/.dino/backup.env, override with DINO_BACKUP_ENV. `chmod 600` it.
#
#   # ~/.dino/backup.env
#   DATABASE_URL='postgresql://postgres:<pw>@db.<ref>.supabase.co:5432/postgres'  # REQUIRED (Settings → Database)
#   BACKUP_DIR="$HOME/dino-backups"          # local staging dir (default)
#   RETENTION_DAYS=30                         # prune local dumps older than this (default 30)
#   BACKUP_PASSPHRASE='<long-random>'         # optional: openssl-encrypt the dump at rest (recommended — it is full user PII)
#   BACKUP_RSYNC_DEST='/Volumes/Backup/dino'  # optional: off-host copy target (dir or user@host:/path)
#
# Schedule it with scripts/launchd/com.dino.backup.plist (see that file's header).
# Recommended one-time setup so this does NOT depend on Docker Desktop:
#   brew install libpq && brew link --force libpq    # gives a native pg_dump/psql
# =========================================================
set -euo pipefail

# launchd starts jobs with a minimal PATH — add the usual locations for
# node/npm/pg_dump (Homebrew + libpq keg) so they resolve.
export PATH="/opt/homebrew/bin:/opt/homebrew/opt/libpq/bin:/usr/local/bin:/usr/local/opt/libpq/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }

ENV_FILE="${DINO_BACKUP_ENV:-$HOME/.dino/backup.env}"
if [ ! -f "$ENV_FILE" ]; then
  echo "[$(ts)] backup-prod: ERROR config not found: $ENV_FILE (see this script's header)." >&2
  exit 1
fi
# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a

: "${DATABASE_URL:?DATABASE_URL must be set in $ENV_FILE}"
export DATABASE_URL
export BACKUP_DIR="${BACKUP_DIR:-$HOME/dino-backups}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"

REPO="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$BACKUP_DIR"

echo "[$(ts)] backup-prod: starting (dir=$BACKUP_DIR, retention=${RETENTION_DAYS}d)"

# 1. Dump hosted prod (backup-user-data.sh honours DATABASE_URL + BACKUP_DIR).
bash "$REPO/scripts/backup-user-data.sh"
DUMP="$(ls -t "$BACKUP_DIR"/user-data-*.sql 2>/dev/null | head -1)"
[ -n "$DUMP" ] || { echo "[$(ts)] backup-prod: ERROR no dump produced" >&2; exit 1; }
echo "[$(ts)] backup-prod: dump = $DUMP"

OUT="$DUMP"
# 2. Encrypt at rest (optional but recommended — the dump is full user PII).
if [ -n "${BACKUP_PASSPHRASE:-}" ]; then
  ENC="$DUMP.enc"
  openssl enc -aes-256-cbc -pbkdf2 -salt -in "$DUMP" -out "$ENC" -pass env:BACKUP_PASSPHRASE
  rm -f "$DUMP"
  OUT="$ENC"
  echo "[$(ts)] backup-prod: encrypted -> $OUT (plaintext removed)"
  echo "[$(ts)] backup-prod:   decrypt with: openssl enc -d -aes-256-cbc -pbkdf2 -in '$ENC' -out restored.sql -pass env:BACKUP_PASSPHRASE"
else
  echo "[$(ts)] backup-prod: WARNING BACKUP_PASSPHRASE unset — dump stored UNENCRYPTED (it contains user PII)" >&2
fi

# 3. Off-host copy (the whole point of a backup is it survives THIS machine).
if [ -n "${BACKUP_RSYNC_DEST:-}" ]; then
  rsync -a "$OUT" "$BACKUP_RSYNC_DEST"/
  echo "[$(ts)] backup-prod: copied to $BACKUP_RSYNC_DEST"
else
  echo "[$(ts)] backup-prod: WARNING BACKUP_RSYNC_DEST unset — backup stays on THIS machine only" >&2
fi

# 4. Prune old local dumps (plaintext + encrypted) past the retention window.
find "$BACKUP_DIR" -type f \( -name 'user-data-*.sql' -o -name 'user-data-*.sql.enc' \) \
  -mtime +"$RETENTION_DAYS" -print -delete \
  | sed "s|^|[$(ts)] backup-prod: pruned |" || true

echo "[$(ts)] backup-prod: done"
