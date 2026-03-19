#!/bin/bash
# Voice-to-Notion launchd startup script
# Runs docker-compose in foreground so launchd can manage the lifecycle

cd /Users/nick/Downloads/voice-to-notion

# Wait for Docker daemon to be ready (can take a moment after login)
for i in $(seq 1 60); do
  if /usr/local/bin/docker info >/dev/null 2>&1; then
    break
  fi
  echo "[launchd] Waiting for Docker daemon... ($i/60)"
  sleep 2
done

if ! /usr/local/bin/docker info >/dev/null 2>&1; then
  echo "[launchd] Docker daemon not available after 120s, exiting"
  exit 1
fi

echo "[launchd] Docker ready, starting voice-to-notion stack..."

# docker-compose up runs in foreground (no -d) so launchd can track the process
exec /usr/local/bin/docker-compose up --build 2>&1
