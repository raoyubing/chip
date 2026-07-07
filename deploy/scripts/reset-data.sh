#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="$DEPLOY_DIR/docker-compose.yml"
ENV_FILE="$DEPLOY_DIR/.env"
CONFIRM=false
HEALTH_TIMEOUT_SECONDS="${HEALTH_TIMEOUT_SECONDS:-90}"
HEALTH_URL="${HEALTH_URL:-}"

usage() {
	cat <<EOF
Usage: $0 --yes [options]

Delete the SQLite database file and restart xiaosongshu services.
No demo data is loaded automatically; run demo:load explicitly if needed.
RustFS files are kept.

Options:
  --yes                       Required confirmation.
  --health-url <url>          Health URL to wait for. Default: http://127.0.0.1:\${WEB_PORT}/health
  --health-timeout <seconds>  Health wait timeout. Default: 90
  --compose-file <file>       Compose file path. Default: deploy/docker-compose.yml
  --env-file <file>           Env file path. Default: deploy/.env
  -h, --help                  Show this help.
EOF
}

while [[ $# -gt 0 ]]; do
	case "$1" in
		--)
			shift
			;;
		--yes)
			CONFIRM=true
			shift
			;;
		--health-url)
			HEALTH_URL="$2"
			shift 2
			;;
		--health-timeout)
			HEALTH_TIMEOUT_SECONDS="$2"
			shift 2
			;;
		--compose-file)
			COMPOSE_FILE="$2"
			shift 2
			;;
		--env-file)
			ENV_FILE="$2"
			shift 2
			;;
		-h|--help)
			usage
			exit 0
			;;
		*)
			echo "Unknown argument: $1" >&2
			usage >&2
			exit 1
			;;
	esac
done

if [[ "$CONFIRM" != true ]]; then
	echo "Refusing to reset data without --yes." >&2
	usage >&2
	exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
	echo "Env file not found: $ENV_FILE" >&2
	exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

WEB_PORT="${WEB_PORT:-80}"
if [[ -z "$HEALTH_URL" ]]; then
	if [[ "$WEB_PORT" == "80" ]]; then
		HEALTH_URL="http://127.0.0.1/health"
	else
		HEALTH_URL="http://127.0.0.1:$WEB_PORT/health"
	fi
fi

compose() {
	docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

http_ok() {
	local url="$1"

	if command -v curl >/dev/null 2>&1; then
		curl -fsS "$url" >/dev/null
		return $?
	fi

	if command -v wget >/dev/null 2>&1; then
		wget -qO- "$url" >/dev/null
		return $?
	fi

	return 1
}

wait_for_health() {
	local deadline=$((SECONDS + HEALTH_TIMEOUT_SECONDS))

	echo "Waiting for health: $HEALTH_URL"
	until http_ok "$HEALTH_URL"; do
		if (( SECONDS >= deadline )); then
			echo "Health check failed after ${HEALTH_TIMEOUT_SECONDS}s: $HEALTH_URL" >&2
			compose ps >&2 || true
			compose logs --tail=120 xiaosongshu-backend >&2 || true
			exit 1
		fi
		sleep 2
	done
}

echo "Stopping backend and nginx..."
compose stop xiaosongshu-nginx xiaosongshu-backend >/dev/null 2>&1 || true

echo "Deleting SQLite database files..."
rm -f "$DEPLOY_DIR/data/server/xiaosongshu.sqlite" "$DEPLOY_DIR/data/server/xiaosongshu.sqlite-shm" "$DEPLOY_DIR/data/server/xiaosongshu.sqlite-wal"

echo "Starting services..."
compose up -d
wait_for_health

echo "Data reset completed: $HEALTH_URL"
