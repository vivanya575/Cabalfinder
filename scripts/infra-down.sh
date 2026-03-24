#!/usr/bin/env bash
set -euo pipefail

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker CLI is not installed or not on PATH. Nothing to stop."
  exit 0
fi

docker compose -f infra/docker-compose.v2.yml down
