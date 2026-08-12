#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

dev_pid=""
cloudflare_pid=""
stopping=0

stop_processes() {
  if [[ "$stopping" -eq 1 ]]; then
    return
  fi
  stopping=1

  echo
  echo "正在停止项目和 Cloudflare..."

  if [[ -n "$dev_pid" ]] && kill -0 "$dev_pid" 2>/dev/null; then
    kill "$dev_pid" 2>/dev/null || true
  fi
  if [[ -n "$cloudflare_pid" ]] && kill -0 "$cloudflare_pid" 2>/dev/null; then
    kill "$cloudflare_pid" 2>/dev/null || true
  fi

  wait "$dev_pid" 2>/dev/null || true
  wait "$cloudflare_pid" 2>/dev/null || true
}

handle_signal() {
  stop_processes
  exit 130
}

trap stop_processes EXIT
trap handle_signal INT TERM

echo "启动本地项目..."
pnpm dev &
dev_pid=$!

echo "启动 Cloudflare Tunnel..."
pnpm cloudflare &
cloudflare_pid=$!

while true; do
  if ! kill -0 "$dev_pid" 2>/dev/null; then
    wait "$dev_pid"
    echo "本地项目已停止，正在退出。" >&2
    exit 1
  fi

  if ! kill -0 "$cloudflare_pid" 2>/dev/null; then
    wait "$cloudflare_pid"
    echo "Cloudflare Tunnel 已停止，正在退出。" >&2
    exit 1
  fi

  sleep 1
done
