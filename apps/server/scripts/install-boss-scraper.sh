#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SCRAPER_DIR="${BOSS_SCRAPER_DIR:-$SERVER_DIR/tools/boss-zhipin-scraper}"
SCRAPER_REPO="${BOSS_SCRAPER_REPO:-https://github.com/eatmoreduck/boss-zhipin-scraper.git}"
VENV_DIR="${BOSS_SCRAPER_VENV_DIR:-$SERVER_DIR/.venv}"
PYTHON_BIN="${PYTHON:-python3}"

if ! command -v git >/dev/null 2>&1; then
	echo "git is required to download boss-zhipin-scraper." >&2
	exit 1
fi

if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
	echo "$PYTHON_BIN is required." >&2
	exit 1
fi

if [[ -d "$SCRAPER_DIR/.git" ]]; then
	echo "Updating boss-zhipin-scraper: $SCRAPER_DIR"
	git -C "$SCRAPER_DIR" pull --ff-only
else
	echo "Cloning boss-zhipin-scraper into: $SCRAPER_DIR"
	rm -rf "$SCRAPER_DIR"
	mkdir -p "$(dirname "$SCRAPER_DIR")"
	git clone --depth 1 "$SCRAPER_REPO" "$SCRAPER_DIR"
fi

if [[ ! -d "$VENV_DIR" ]]; then
	echo "Creating Python venv: $VENV_DIR"
	"$PYTHON_BIN" -m venv "$VENV_DIR"
fi

PYTHON_IN_VENV="$VENV_DIR/bin/python"
if [[ ! -x "$PYTHON_IN_VENV" ]]; then
	echo "Python venv is not usable: $PYTHON_IN_VENV" >&2
	exit 1
fi

echo "Installing scraper dependencies..."
"$PYTHON_IN_VENV" -m pip install --upgrade pip
"$PYTHON_IN_VENV" -m pip install -r "$SCRAPER_DIR/requirements.txt"

cat <<EOF

boss-zhipin-scraper is ready.

Next:
  pnpm --filter @xiaosongshu/server boss-scraper:setup-chrome
  pnpm --filter @xiaosongshu/server boss-scraper:check
EOF
