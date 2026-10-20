#!/bin/bash
# Refresh the Magnolia Made Cookies Instagram snapshot and deploy.
# Installed as a launchd job; safe to run manually any time.
set -euo pipefail

REPO="/Users/jaime/.openclaw/workspace/magnolia-made-cookies"
ENV_FILE="$HOME/.config/mm-refresh/env"
LOG_DIR="$HOME/.config/mm-refresh/logs"
LOG="$LOG_DIR/refresh.log"

mkdir -p "$LOG_DIR"

# Load the Cloudflare token.
if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  set -a; source "$ENV_FILE"; set +a
fi

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: CLOUDFLARE_API_TOKEN not set" >> "$LOG"
  exit 1
fi

# launchd's minimal environment has no CA store, which makes Node's fetch fail
# with UNABLE_TO_GET_ISSUER_CERT_LOCALLY. Point it at the system bundle.
export NODE_EXTRA_CA_CERTS="${NODE_EXTRA_CA_CERTS:-/etc/ssl/cert.pem}"

cd "$REPO"

# Keep the log bounded (last ~2000 lines).
if [ -f "$LOG" ] && [ "$(wc -l < "$LOG")" -gt 2000 ]; then
  tail -n 1000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] starting refresh" >> "$LOG"

# Don't fight an in-progress manual edit.
if [ -n "$(git status --porcelain | grep -v '^??')" ]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] SKIP: working tree dirty" >> "$LOG"
  exit 0
fi

if /usr/local/bin/node "$REPO/scripts/refresh-instagram.mjs" >> "$LOG" 2>&1; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] OK" >> "$LOG"
else
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] FAILED (see above)" >> "$LOG"
  exit 1
fi
