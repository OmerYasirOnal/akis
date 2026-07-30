#!/usr/bin/env bash
# scripts/akis-backuppull.sh — pull the latest akis-*.sql.gz backups from the
# production box and prune to the newest N, retrying on transient network
# failures and alerting via Telegram if every attempt fails.
#
# Extracted from the inline command that used to live directly in
# ~/Library/LaunchAgents/com.akis.backuppull.plist:
#   mkdir -p ~/Projects/akis-backups && scp ... 'ubuntu@HOST:~/akis-backups/akis-*.sql.gz' \
#     ~/Projects/akis-backups/ && cd ~/Projects/akis-backups && ls -t akis-*.sql.gz | tail -n +31 | xargs rm
# That version had no retry and failed silently on a transient "Operation timed out".
#
# Usage: ./scripts/akis-backuppull.sh
#
# Env:
#   AKIS_BACKUP_HOST        (default: 141.147.25.123) prod box ssh host/IP
#   AKIS_BACKUP_USER        (default: ubuntu)
#   AKIS_BACKUP_REMOTE_DIR  (default: akis-backups) remote dir (relative to the
#                           remote user's home) holding akis-*.sql.gz
#   AKIS_BACKUP_LOCAL_DIR   (default: ~/Projects/akis-backups) local destination
#   AKIS_BACKUP_KEEP        (default: 30) newest backups to retain locally
#   AKIS_BACKUP_RETRIES     (default: 3) scp attempts before giving up
#   AKIS_BACKUP_RETRY_DELAY (default: 30) seconds to wait between retries
#   AKIS_ENV_FILE           (default: backend/.env next to this repo) sourced
#                           for TG_BOT_TOKEN / TG_CHAT_ID if not already set —
#                           same convention as scripts/dev.sh.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

HOST="${AKIS_BACKUP_HOST:-141.147.25.123}"
BUSER="${AKIS_BACKUP_USER:-ubuntu}"
REMOTE_DIR="${AKIS_BACKUP_REMOTE_DIR:-akis-backups}"
LOCAL_DIR="${AKIS_BACKUP_LOCAL_DIR:-$HOME/Projects/akis-backups}"
KEEP="${AKIS_BACKUP_KEEP:-30}"
RETRIES="${AKIS_BACKUP_RETRIES:-3}"
RETRY_DELAY="${AKIS_BACKUP_RETRY_DELAY:-30}"

# TG_BOT_TOKEN/TG_CHAT_ID are shared across projects (same names as
# promptane-gen's .env) — pick them up from backend/.env if not already exported
# (launchd runs this with a near-empty environment, unlike an interactive shell).
ENV_FILE="${AKIS_ENV_FILE:-$ROOT/backend/.env}"
if [[ -z "${TG_BOT_TOKEN:-}" || -z "${TG_CHAT_ID:-}" ]] && [ -f "$ENV_FILE" ]; then
  set -a; . "$ENV_FILE"; set +a
fi

mkdir -p "$LOCAL_DIR"

notify_failure() {
  local message="$1"
  echo "[akis-backuppull] $message" >&2
  if [[ -n "${TG_BOT_TOKEN:-}" && -n "${TG_CHAT_ID:-}" ]]; then
    /usr/bin/curl -sS --max-time 10 \
      "https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage" \
      --data-urlencode "chat_id=${TG_CHAT_ID}" \
      --data-urlencode "text=akis-backuppull: ${message}" \
      >/dev/null || echo "[akis-backuppull] Telegram notify also failed" >&2
  else
    echo "[akis-backuppull] TG_BOT_TOKEN/TG_CHAT_ID not set — skipping Telegram alert" >&2
  fi
}

ok=0
for attempt in $(seq 1 "$RETRIES"); do
  echo "[akis-backuppull] scp attempt ${attempt}/${RETRIES}"
  if /usr/bin/scp -o ConnectTimeout=20 "${BUSER}@${HOST}:${REMOTE_DIR}/akis-*.sql.gz" "$LOCAL_DIR/"; then
    ok=1
    break
  fi
  if [[ "$attempt" -lt "$RETRIES" ]]; then
    echo "[akis-backuppull] attempt ${attempt} failed, retrying in ${RETRY_DELAY}s"
    sleep "$RETRY_DELAY"
  fi
done

if [[ "$ok" -ne 1 ]]; then
  notify_failure "backup pull from ${HOST} failed after ${RETRIES} attempts"
  exit 1
fi

cd "$LOCAL_DIR"
ls -t akis-*.sql.gz 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -I{} rm -- {}
echo "[akis-backuppull] done — $(ls akis-*.sql.gz 2>/dev/null | wc -l | tr -d ' ') backups retained in ${LOCAL_DIR}"
