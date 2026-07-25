#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCAL_NODE_BIN="$ROOT_DIR/.local-tools/node-v22.12.0-darwin-x64/bin"

if [[ -x "$LOCAL_NODE_BIN/node" ]]; then
  export PATH="$LOCAL_NODE_BIN:$PATH"
fi

node -e "const [major, minor] = process.versions.node.split('.').map(Number); if (!((major === 20 && minor >= 19) || major >= 22)) { console.error('当前 Node.js 版本为 ' + process.version + '，小松鼠需要 Node.js >=20.19 或 >=22.12。'); process.exit(1); }"

exec "$@"
