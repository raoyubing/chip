#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKUP_DIR="$DEPLOY_DIR/backups"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
OUTPUT_FILE="$BACKUP_DIR/xiaosongshu-data-$TIMESTAMP.tgz"

usage() {
	cat <<EOF
Usage: $0 [options]

Create a tar.gz backup of deploy/data.

Options:
  -o, --output <file>  Output file. Default: deploy/backups/xiaosongshu-data-<timestamp>.tgz
  -h, --help           Show this help.
EOF
}

while [[ $# -gt 0 ]]; do
	case "$1" in
		--)
			shift
			;;
		-o|--output)
			OUTPUT_FILE="$2"
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

if [[ ! -d "$DEPLOY_DIR/data" ]]; then
	echo "Data directory not found: $DEPLOY_DIR/data" >&2
	exit 1
fi

mkdir -p "$(dirname "$OUTPUT_FILE")"
tar -C "$DEPLOY_DIR" -czf "$OUTPUT_FILE" data

echo "Wrote backup: $OUTPUT_FILE"
