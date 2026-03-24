#!/usr/bin/env bash
set -euo pipefail

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker CLI is not installed or not on PATH."
  echo "Install Docker Desktop (or Colima + docker cli), then retry: npm run infra:up"
  echo "If you already have external Postgres/Redis, skip local infra and run: npm run dev:v2:no-infra"
  exit 127
fi

docker compose -f infra/docker-compose.v2.yml up -d
