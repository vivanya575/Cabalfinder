#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RUN_DIR="$ROOT_DIR/.run"
LOG_DIR="$ROOT_DIR/.run/logs"
UI_PID_FILE="$RUN_DIR/dev-ui.pid"
FULL_PID_FILE="$RUN_DIR/dev-full.pid"

mkdir -p "$LOG_DIR"

has_docker() {
  command -v docker >/dev/null 2>&1
}

start_infra_if_available() {
  if has_docker; then
    (cd "$ROOT_DIR" && npm run infra:up >>"$LOG_DIR/infra.log" 2>&1) || true
  fi
}

kill_pid_file() {
  local pid_file="$1"
  if [[ -f "$pid_file" ]]; then
    local pid
    pid="$(cat "$pid_file")"
    if [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1; then
      kill -TERM "$pid" >/dev/null 2>&1 || true
      sleep 1
      kill -0 "$pid" >/dev/null 2>&1 && kill -KILL "$pid" >/dev/null 2>&1 || true
    fi
    rm -f "$pid_file"
  fi
}

start_mode() {
  local mode="$1"
  local pid_file="$2"
  local log_file="$3"
  local npm_script="$4"

  kill_pid_file "$UI_PID_FILE"
  kill_pid_file "$FULL_PID_FILE"

  start_infra_if_available

  (
    cd "$ROOT_DIR"
    nohup npm run "$npm_script" >"$log_file" 2>&1 &
    echo $! >"$pid_file"
  )

  sleep 2
  open "http://localhost:3000" >/dev/null 2>&1 || true
  osascript -e "display notification \"Cabalfinder $mode started\" with title \"Cabalfinder Launcher\"" >/dev/null 2>&1 || true
}

stop_all() {
  kill_pid_file "$UI_PID_FILE"
  kill_pid_file "$FULL_PID_FILE"

  if has_docker; then
    (cd "$ROOT_DIR" && npm run infra:down >>"$LOG_DIR/infra.log" 2>&1) || true
  fi

  osascript -e 'display notification "Cabalfinder stopped" with title "Cabalfinder Launcher"' >/dev/null 2>&1 || true
}

status() {
  local msg="Cabalfinder status:\n"
  if [[ -f "$UI_PID_FILE" ]] && kill -0 "$(cat "$UI_PID_FILE")" >/dev/null 2>&1; then
    msg+="- UI mode running\n"
  fi
  if [[ -f "$FULL_PID_FILE" ]] && kill -0 "$(cat "$FULL_PID_FILE")" >/dev/null 2>&1; then
    msg+="- Full mode running\n"
  fi
  if has_docker; then
    msg+="- Docker CLI detected"
  else
    msg+="- Docker CLI not detected"
  fi
  osascript -e "display dialog \"$msg\" buttons {\"OK\"} default button \"OK\" with title \"Cabalfinder Launcher\"" >/dev/null 2>&1 || true
}

case "${1:-}" in
  start-ui)
    start_mode "UI" "$UI_PID_FILE" "$LOG_DIR/dev-ui.log" "dev:v2:no-infra"
    ;;
  start-full)
    start_mode "Full" "$FULL_PID_FILE" "$LOG_DIR/dev-full.log" "dev:v2:full"
    ;;
  stop)
    stop_all
    ;;
  status)
    status
    ;;
  *)
    echo "Usage: $0 {start-ui|start-full|stop|status}" >&2
    exit 1
    ;;
esac
