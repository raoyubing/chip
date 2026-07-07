#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="$DEPLOY_DIR/docker-compose.yml"
ENV_FILE="$DEPLOY_DIR/.env"
COMMAND_STRING=""

usage() {
	cat <<EOF
Usage:
  $0 [options] '<command string>'

Run a command inside the xiaosongshu Node 22 container.

Examples:
  $0 'pnpm build'
  $0 'pnpm --filter @xiaosongshu/server download:whisper-model'
  $0 'pnpm --filter @xiaosongshu/server demo:load -- --reset'

Options:
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
		-*)
			echo "Unknown argument: $1" >&2
			usage >&2
			exit 1
			;;
		*)
			if [[ -n "$COMMAND_STRING" ]]; then
				echo "Only one command string is supported. Wrap the full command in quotes." >&2
				usage >&2
				exit 1
			fi
			COMMAND_STRING="$1"
			shift
			;;
	esac
done

if [[ -z "$COMMAND_STRING" ]]; then
	echo "Command is required." >&2
	usage >&2
	exit 1
fi

if [[ ! -f "$COMPOSE_FILE" ]]; then
	echo "Compose file not found: $COMPOSE_FILE" >&2
	exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
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

command="corepack enable && corepack prepare pnpm@8.14.0 --activate && pnpm config set store-dir /pnpm/store && $COMMAND_STRING"

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" run --rm --no-deps xiaosongshu-backend sh -lc "$command"
