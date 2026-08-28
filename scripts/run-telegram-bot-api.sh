#!/usr/bin/env bash
#
# Run a local Telegram Bot API server so bots can download files above the
# cloud 20MB getFile cap (and upload above 50MB), up to ~2GB.
#
# Requires TELEGRAM_API_ID and TELEGRAM_API_HASH from https://my.telegram.org
# (API development tools). Optional: TELEGRAM_BOT_API_PORT (default 8081).
#
# Usage:
#   bash scripts/run-telegram-bot-api.sh          # start/replace the server
#   bash scripts/run-telegram-bot-api.sh switch   # stop NanoClaw, logOut of
#                                                 # cloud API, start server,
#                                                 # set TELEGRAM_API_ROOT, restart
#
# First switch must logOut against api.telegram.org while NanoClaw is stopped,
# or Telegram keeps the tokens pinned to the cloud Bot API.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$PROJECT_ROOT/.env"
IMAGE="${TELEGRAM_BOT_API_IMAGE:-aiogram/telegram-bot-api:latest}"
NAME="${TELEGRAM_BOT_API_CONTAINER:-telegram-bot-api}"
PORT="${TELEGRAM_BOT_API_PORT:-8081}"
DATA_DIR="${TELEGRAM_BOT_API_DATA:-$PROJECT_ROOT/data/telegram-bot-api}"
PLIST="${HOME}/Library/LaunchAgents/com.personal-golf.nanoclaw-main.plist"
LABEL="gui/$(id -u)/com.personal-golf.nanoclaw-main"

read_env() {
  local key="$1"
  if [[ -n "${!key:-}" ]]; then
    printf '%s' "${!key}"
    return
  fi
  [[ -f "$ENV_FILE" ]] || return 0
  local line
  line="$(grep -E "^${key}=" "$ENV_FILE" | tail -n1 || true)"
  [[ -n "$line" ]] || return 0
  local value="${line#*=}"
  value="${value%\"}"
  value="${value#\"}"
  value="${value%\'}"
  value="${value#\'}"
  printf '%s' "$value"
}

ensure_credentials() {
  API_ID="$(read_env TELEGRAM_API_ID)"
  API_HASH="$(read_env TELEGRAM_API_HASH)"
  if [[ -z "$API_ID" || -z "$API_HASH" ]]; then
    echo "Missing TELEGRAM_API_ID / TELEGRAM_API_HASH."
    echo "Create them at https://my.telegram.org → API development tools, then add both to .env."
    exit 1
  fi
}

bot_tokens() {
  local raw
  raw="$(read_env TELEGRAM_BOT_TOKENS)"
  if [[ -z "$raw" ]]; then
    raw="$(read_env TELEGRAM_BOT_TOKEN)"
  fi
  echo "$raw" | tr ', ' '\n' | sed '/^$/d' | awk 'NF && !seen[$0]++'
}

ensure_api_root() {
  if grep -qE '^TELEGRAM_API_ROOT=' "$ENV_FILE" 2>/dev/null; then
    if grep -qE '^TELEGRAM_API_ROOT=http://127\.0\.0\.1:' "$ENV_FILE"; then
      return
    fi
    local tmp
    tmp="$(mktemp)"
    sed -E "s|^TELEGRAM_API_ROOT=.*|TELEGRAM_API_ROOT=http://127.0.0.1:${PORT}|" "$ENV_FILE" > "$tmp"
    mv "$tmp" "$ENV_FILE"
  else
    printf '\nTELEGRAM_API_ROOT=http://127.0.0.1:%s\n' "$PORT" >> "$ENV_FILE"
  fi
}

start_server() {
  ensure_credentials
  if ! command -v docker >/dev/null 2>&1; then
    echo "docker is required to run the local Telegram Bot API server."
    exit 1
  fi

  mkdir -p "$DATA_DIR"

  if docker ps -a --format '{{.Names}}' | grep -qx "$NAME"; then
    docker rm -f "$NAME" >/dev/null
  fi

  docker pull "$IMAGE"
  docker run -d \
    --name "$NAME" \
    --restart unless-stopped \
    -p "127.0.0.1:${PORT}:8081" \
    -v "$DATA_DIR:/var/lib/telegram-bot-api" \
    -e TELEGRAM_API_ID="$API_ID" \
    -e TELEGRAM_API_HASH="$API_HASH" \
    -e TELEGRAM_LOCAL=1 \
    "$IMAGE"

  echo "Waiting for local Telegram Bot API on http://127.0.0.1:${PORT} ..."
  local i
  for i in $(seq 1 30); do
    # GET / is 404 JSON; any HTTP response means the server is listening.
    if curl -sS --max-time 2 -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/" | grep -qE '^[1-5][0-9][0-9]$'; then
      echo "Local Telegram Bot API listening on http://127.0.0.1:${PORT}"
      return
    fi
    sleep 1
  done
  echo "Server did not become ready. Last logs:"
  docker logs "$NAME" 2>&1 | tail -40
  exit 1
}

logout_cloud_bots() {
  local token
  local any=0
  while IFS= read -r token; do
    [[ -z "$token" ]] && continue
    any=1
    echo "logOut cloud Bot API for token ending ${token: -6}"
    curl -sS -X POST "https://api.telegram.org/bot${token}/logOut" || true
    echo
  done < <(bot_tokens)
  if [[ "$any" -eq 0 ]]; then
    echo "No TELEGRAM_BOT_TOKEN / TELEGRAM_BOT_TOKENS found; skipped logOut."
  fi
}

stop_nanoclaw() {
  if [[ -f "$PLIST" ]]; then
    launchctl bootout "$LABEL" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true
  fi
}

start_nanoclaw() {
  if [[ -f "$PLIST" ]]; then
    launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || launchctl load "$PLIST" 2>/dev/null || true
    launchctl kickstart -k "$LABEL"
  else
    echo "LaunchAgent plist not found at $PLIST — start NanoClaw yourself."
  fi
}

cmd="${1:-start}"
case "$cmd" in
  start)
    start_server
    echo "Set TELEGRAM_API_ROOT=http://127.0.0.1:${PORT} in .env, then restart NanoClaw."
    echo "First switch: bash scripts/run-telegram-bot-api.sh switch"
    ;;
  switch)
    ensure_credentials
    echo "Stopping NanoClaw..."
    stop_nanoclaw
    sleep 2
    logout_cloud_bots
    start_server
    ensure_api_root
    echo "Rebuilding host and restarting NanoClaw..."
    (cd "$PROJECT_ROOT" && npm run build)
    start_nanoclaw
    echo "Cutover complete. Bots should log apiRoot=http://127.0.0.1:${PORT}."
    ;;
  *)
    echo "Unknown command: $cmd (start|switch)"
    exit 1
    ;;
esac
