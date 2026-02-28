#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[boot]${NC} $1"; }
warn() { echo -e "${YELLOW}[boot]${NC} $1"; }
err()  { echo -e "${RED}[boot]${NC} $1"; }

# --- Preflight checks ---
if ! docker info >/dev/null 2>&1; then
  err "Docker daemon is not running. Start Docker Desktop and re-run."
  exit 1
fi

if [ ! -f .env ]; then
  err ".env not found. Run: cp .env.example .env and fill in your keys."
  exit 1
fi

source .env

if [ -z "${NOTION_API_KEY:-}" ] || [ "$NOTION_API_KEY" = "secret_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" ]; then
  err "NOTION_API_KEY is not set in .env"
  exit 1
fi

if [ -z "${NOTION_DATABASE_ID:-}" ] || [ "$NOTION_DATABASE_ID" = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" ]; then
  err "NOTION_DATABASE_ID is not set in .env"
  exit 1
fi

if [ -z "${SCRIBERR_USERNAME:-}" ] || [ "$SCRIBERR_USERNAME" = "your_username" ]; then
  err "SCRIBERR_USERNAME is not set in .env"
  exit 1
fi

if [ -z "${SCRIBERR_PASSWORD:-}" ] || [ "$SCRIBERR_PASSWORD" = "your_password" ]; then
  err "SCRIBERR_PASSWORD is not set in .env"
  exit 1
fi

# --- Phase 1: Start Scriberr ---
log "Starting Scriberr..."
docker compose up -d scriberr

log "Waiting for Scriberr to become healthy (model download may take a few minutes on first run)..."
TIMEOUT=300
ELAPSED=0
while [ $ELAPSED -lt $TIMEOUT ]; do
  STATUS=$(docker inspect --format='{{.State.Health.Status}}' scriberr 2>/dev/null || echo "not_found")
  case "$STATUS" in
    healthy)
      log "Scriberr is healthy."
      break
      ;;
    unhealthy)
      err "Scriberr failed health check. Run: docker compose logs scriberr"
      exit 1
      ;;
    *)
      printf "\r  waiting... %ds / %ds" "$ELAPSED" "$TIMEOUT"
      sleep 5
      ELAPSED=$((ELAPSED + 5))
      ;;
  esac
done

if [ $ELAPSED -ge $TIMEOUT ]; then
  err "Scriberr did not become healthy within ${TIMEOUT}s. Check: docker compose logs scriberr"
  exit 1
fi

# --- Phase 2: Build and start worker ---
log "Building and starting notion-worker..."
docker compose up -d --build notion-worker

log "Tailing worker logs (Ctrl-C to detach)..."
echo ""
docker compose logs -f notion-worker
