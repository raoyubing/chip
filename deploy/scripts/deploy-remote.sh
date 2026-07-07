#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

ENV_NAME=""

usage() {
	cat <<EOF
Usage: $0 <env> [options]

Trigger a xiaosongshu update on a Linux server through SSH.

The script reads remote config from ci/<env>.json.

Required config fields:
  host      SSH host or IP.
  path      Repo path on server.

Optional config fields:
  user      SSH user. If omitted, SSH uses the current local username.
  port      SSH port. Default: 22.
  branch    Git branch to pull. Default: current local branch.

Options:
  --skip-model-download  Do not download the local Whisper model.
  -h, --help             Show this help.

Example:
  bash deploy/scripts/deploy-remote.sh dev
EOF
}

DOWNLOAD_MODEL=true

while [[ $# -gt 0 ]]; do
	case "$1" in
		--)
			shift
			;;
		--skip-model-download)
			DOWNLOAD_MODEL=false
			shift
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
			if [[ -n "$ENV_NAME" ]]; then
				echo "Only one environment name is allowed." >&2
				usage >&2
				exit 1
			fi
			ENV_NAME="$1"
			shift
			;;
	esac
done

if [[ -z "$ENV_NAME" ]]; then
	echo "Environment name is required." >&2
	usage >&2
	exit 1
fi

CONFIG_FILE="$ROOT_DIR/ci/$ENV_NAME.json"
if [[ ! -f "$CONFIG_FILE" ]]; then
	echo "Deploy config not found: $CONFIG_FILE" >&2
	exit 1
fi

if ! command -v node >/dev/null 2>&1; then
	echo "node is required to read $CONFIG_FILE." >&2
	exit 1
fi

read_config() {
	node - "$CONFIG_FILE" <<'NODE'
const fs = require('node:fs')

const configFile = process.argv[2]
const config = JSON.parse(fs.readFileSync(configFile, 'utf8'))

function readString(keys) {
	for (const key of keys) {
		const value = config[key]
		if (typeof value === 'string' && value.trim()) return value.trim()
		if (typeof value === 'number') return String(value)
	}
	return ''
}

const host = readString(['host', 'remote_host', 'remoteHost'])
const user = readString(['user', 'username', 'ssh_user', 'sshUser'])
const path = readString(['path', 'dir', 'remote_dir', 'remoteDir'])
const branch = readString(['branch'])
const port = readString(['port', 'ssh_port', 'sshPort'])

if (!host) throw new Error(`Missing required config field "host" in ${configFile}`)
if (!path) throw new Error(`Missing required config field "path" in ${configFile}`)
if (host.includes('@')) throw new Error(`Use separate "user" and "host" fields in ${configFile}`)

console.log([host, user, path, branch, port].join('\t'))
NODE
}

IFS=$'\t' read -r REMOTE_HOST SSH_USER REMOTE_DIR BRANCH SSH_PORT < <(read_config)

if [[ -z "$BRANCH" ]]; then
	BRANCH="$(git -C "$ROOT_DIR" rev-parse --abbrev-ref HEAD)"
fi

quote() {
	printf '%q' "$1"
}

build_command="corepack enable && corepack prepare pnpm@8.14.0 --activate && pnpm config set store-dir /pnpm/store && pnpm install --frozen-lockfile && pnpm --filter @xiaosongshu/shared build && pnpm --filter @xiaosongshu/server build && pnpm --filter @xiaosongshu/web build"
if [[ "$DOWNLOAD_MODEL" == true ]]; then
	build_command="$build_command && pnpm --filter @xiaosongshu/server download:whisper-model"
fi

remote_command=$(cat <<EOF
set -euo pipefail
cd $(quote "$REMOTE_DIR")
echo "[deploy] fetch $(quote "$BRANCH")"
git fetch origin $(quote "$BRANCH")
echo "[deploy] checkout $(quote "$BRANCH")"
git checkout $(quote "$BRANCH")
echo "[deploy] pull $(quote "$BRANCH")"
git pull --ff-only origin $(quote "$BRANCH")
if [[ ! -f deploy/.env && -f deploy/.env.example ]]; then
	cp deploy/.env.example deploy/.env
	echo "Created deploy/.env from deploy/.env.example. Edit it on the server and rerun." >&2
	exit 1
fi
echo "[deploy] build in node container"
docker compose --env-file deploy/.env -f deploy/docker-compose.yml run --rm --no-deps -T xiaosongshu-backend sh -lc $(quote "$build_command")
echo "[deploy] start runtime services"
docker compose --env-file deploy/.env -f deploy/docker-compose.yml up -d
echo "[deploy] restart runtime services"
docker compose --env-file deploy/.env -f deploy/docker-compose.yml restart xiaosongshu-backend xiaosongshu-nginx
EOF
)

ssh_args=()
if [[ -n "$SSH_USER" ]]; then
	ssh_args+=(-l "$SSH_USER")
fi
if [[ -n "$SSH_PORT" ]]; then
	ssh_args+=(-p "$SSH_PORT")
fi

echo "Deploying $ENV_NAME: $BRANCH to $REMOTE_HOST:$REMOTE_DIR"
ssh "${ssh_args[@]}" "$REMOTE_HOST" "$remote_command"
