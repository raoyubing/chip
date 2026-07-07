#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="$DEPLOY_DIR/docker-compose.yml"
ENV_FILE="$DEPLOY_DIR/.env"

LOAD_IMAGES=true
RUN_BUILD=true
DOWNLOAD_MODEL=true
HEALTH_TIMEOUT_SECONDS="${HEALTH_TIMEOUT_SECONDS:-90}"
HEALTH_URL="${HEALTH_URL:-}"

usage() {
	cat <<EOF
Usage: $0 [options]

Initialize or refresh the xiaosongshu deployment.

Options:
  --skip-load-images          Do not load deploy/images/xiaosongshu-images.tar.
  --skip-build                Do not install dependencies or build apps.
  --skip-model-download       Do not download the local Whisper model.
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
		--skip-load-images)
			LOAD_IMAGES=false
			shift
			;;
		--skip-build)
			RUN_BUILD=false
			shift
			;;
		--skip-model-download)
			DOWNLOAD_MODEL=false
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

if [[ ! -f "$COMPOSE_FILE" ]]; then
	echo "Compose file not found: $COMPOSE_FILE" >&2
	exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
	if [[ "$ENV_FILE" == "$DEPLOY_DIR/.env" && -f "$DEPLOY_DIR/.env.example" ]]; then
		cp "$DEPLOY_DIR/.env.example" "$ENV_FILE"
		cat >&2 <<EOF
Created $ENV_FILE from deploy/.env.example.
Edit it first, then rerun this script.
EOF
		exit 1
	fi

	echo "Env file not found: $ENV_FILE" >&2
	exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
	echo "docker is required." >&2
	exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
	echo "docker compose is required." >&2
	exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

WEB_PORT="${WEB_PORT:-80}"
RUSTFS_API_PORT="${RUSTFS_API_PORT:-9000}"
RUSTFS_CONSOLE_PORT="${RUSTFS_CONSOLE_PORT:-9001}"
RUSTFS_LEGACY_ACCESS_KEY="${RUSTFS_ACCESS_KEY:-}"
RUSTFS_LEGACY_SECRET_KEY="${RUSTFS_SECRET_KEY:-}"
RUSTFS_ROOT_ACCESS_KEY="${RUSTFS_ROOT_ACCESS_KEY:-$RUSTFS_LEGACY_ACCESS_KEY}"
RUSTFS_ROOT_SECRET_KEY="${RUSTFS_ROOT_SECRET_KEY:-$RUSTFS_LEGACY_SECRET_KEY}"
RUSTFS_ACCESS_KEY_ID="${RUSTFS_ACCESS_KEY_ID:-$RUSTFS_LEGACY_ACCESS_KEY}"
RUSTFS_SECRET_ACCESS_KEY="${RUSTFS_SECRET_ACCESS_KEY:-$RUSTFS_LEGACY_SECRET_KEY}"
FILE_PROXY_SECRET="${FILE_PROXY_SECRET:-}"

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

generate_token() {
	if command -v openssl >/dev/null 2>&1; then
		openssl rand -hex 16
		return
	fi

	if command -v od >/dev/null 2>&1 && [[ -r /dev/urandom ]]; then
		od -An -N16 -tx1 /dev/urandom | tr -d ' \n'
		echo
		return
	fi

	date +%s%N
}

set_env_value() {
	local key="$1"
	local value="$2"
	local escaped_value

	escaped_value="$(printf '%s' "$value" | sed 's/[\/&]/\\&/g')"
	if grep -q "^$key=" "$ENV_FILE"; then
		sed -i "s/^$key=.*/$key=$escaped_value/" "$ENV_FILE"
	else
		printf '\n%s=%s\n' "$key" "$value" >> "$ENV_FILE"
	fi
}

is_invalid_or_placeholder() {
	local value="$1"

	[[ -z "$value" ]] ||
	[[ "$value" == change-me-* ]] ||
	[[ "$value" == "admin" ]] ||
	[[ "$value" == "rustfsadmin" ]]
}

validate_env() {
	if is_invalid_or_placeholder "$RUSTFS_ROOT_ACCESS_KEY" || is_invalid_or_placeholder "$RUSTFS_ROOT_SECRET_KEY"; then
		RUSTFS_ROOT_ACCESS_KEY="root$(generate_token)"
		RUSTFS_ROOT_SECRET_KEY="root$(generate_token)"
		set_env_value RUSTFS_ROOT_ACCESS_KEY "$RUSTFS_ROOT_ACCESS_KEY"
		set_env_value RUSTFS_ROOT_SECRET_KEY "$RUSTFS_ROOT_SECRET_KEY"
		echo "Generated RustFS root credentials in $ENV_FILE."
	fi

	if is_invalid_or_placeholder "$RUSTFS_ACCESS_KEY_ID" || is_invalid_or_placeholder "$RUSTFS_SECRET_ACCESS_KEY"; then
		RUSTFS_ACCESS_KEY_ID="$RUSTFS_ROOT_ACCESS_KEY"
		RUSTFS_SECRET_ACCESS_KEY="$RUSTFS_ROOT_SECRET_KEY"
		set_env_value RUSTFS_ACCESS_KEY_ID "$RUSTFS_ACCESS_KEY_ID"
		set_env_value RUSTFS_SECRET_ACCESS_KEY "$RUSTFS_SECRET_ACCESS_KEY"
		echo "Generated RustFS app credentials in $ENV_FILE."
	fi

	if is_invalid_or_placeholder "$FILE_PROXY_SECRET"; then
		FILE_PROXY_SECRET="file$(generate_token)"
		set_env_value FILE_PROXY_SECRET "$FILE_PROXY_SECRET"
		echo "Generated FILE_PROXY_SECRET in $ENV_FILE."
	fi

	if (( ${#RUSTFS_ROOT_SECRET_KEY} < 8 || ${#RUSTFS_SECRET_ACCESS_KEY} < 8 )); then
		echo "RustFS secret keys must be at least 8 characters." >&2
		exit 1
	fi
}

prepare_data_dirs() {
	mkdir -p "$DEPLOY_DIR/data/server" "$DEPLOY_DIR/data/rustfs" "$DEPLOY_DIR/pnpm-store"
	chmod 0777 "$DEPLOY_DIR/data/rustfs" "$DEPLOY_DIR/pnpm-store"
}

tcp_ok() {
	local host="$1"
	local port="$2"

	if command -v nc >/dev/null 2>&1; then
		nc -z "$host" "$port" >/dev/null 2>&1
		return $?
	fi

	if command -v bash >/dev/null 2>&1; then
		timeout 2 bash -c "</dev/tcp/$host/$port" >/dev/null 2>&1
		return $?
	fi

	return 1
}

wait_for_rustfs_ports() {
	local deadline=$((SECONDS + 45))

	echo "Waiting for RustFS ports: $RUSTFS_API_PORT, $RUSTFS_CONSOLE_PORT"
	until tcp_ok 127.0.0.1 "$RUSTFS_API_PORT" && tcp_ok 127.0.0.1 "$RUSTFS_CONSOLE_PORT"; do
		if (( SECONDS >= deadline )); then
			echo "RustFS ports did not become reachable in 45 seconds." >&2
			compose ps xiaosongshu-rustfs >&2 || true
			compose logs --tail=120 xiaosongshu-rustfs >&2 || true
			exit 1
		fi
		sleep 2
	done
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

	compose exec -T xiaosongshu-backend node -e "fetch('http://127.0.0.1:5175/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1
}

wait_for_health() {
	local deadline=$((SECONDS + HEALTH_TIMEOUT_SECONDS))

	echo "Waiting for health: $HEALTH_URL"
	until http_ok "$HEALTH_URL"; do
		if (( SECONDS >= deadline )); then
			echo "Health check failed after ${HEALTH_TIMEOUT_SECONDS}s: $HEALTH_URL" >&2
			compose ps >&2 || true
			compose logs --tail=120 xiaosongshu-backend >&2 || true
			compose logs --tail=120 xiaosongshu-nginx >&2 || true
			exit 1
		fi
		sleep 2
	done
}

run_node_workspace_command() {
	local command="$1"

	compose run --rm --no-deps xiaosongshu-backend sh -lc "corepack enable && corepack prepare pnpm@8.14.0 --activate && pnpm config set store-dir /pnpm/store && $command"
}

if [[ "$LOAD_IMAGES" == true && -f "$DEPLOY_DIR/images/xiaosongshu-images.tar" ]]; then
	bash "$DEPLOY_DIR/scripts/load-images.sh" --compose-file "$COMPOSE_FILE" --env-file "$ENV_FILE"
fi

validate_env
prepare_data_dirs

if [[ "$RUN_BUILD" == true ]]; then
	workspace_command="pnpm install --frozen-lockfile && pnpm --filter @xiaosongshu/shared build && pnpm --filter @xiaosongshu/server build && pnpm --filter @xiaosongshu/web build"
	if [[ "$DOWNLOAD_MODEL" == true ]]; then
		workspace_command="$workspace_command && pnpm --filter @xiaosongshu/server download:whisper-model"
	fi

	echo "Installing dependencies and building apps..."
	run_node_workspace_command "$workspace_command"
fi

echo "Starting base services..."
compose up -d xiaosongshu-rustfs xiaosongshu-kkfileview
wait_for_rustfs_ports

echo "Starting xiaosongshu services..."
compose up -d
wait_for_health

echo "xiaosongshu is ready: $HEALTH_URL"
