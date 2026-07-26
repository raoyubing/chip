#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT_DIR="$(cd "$DEPLOY_DIR/.." && pwd)"
OCR_DIR="$DEPLOY_DIR/ocr"
COMPOSE_FILE="$OCR_DIR/docker-compose.yml"
ENV_FILE="$OCR_DIR/.env"
ACTION="${1:-up}"

if [[ ! -f "$ENV_FILE" ]]; then
	ENV_FILE="$OCR_DIR/.env.example"
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

has_ppocrv6_models() {
	local model_dir="$1"
	[[ -f "$model_dir/PP-OCRv6_medium_det/inference.pdiparams" \
		&& -f "$model_dir/PP-OCRv6_medium_rec/inference.pdiparams" ]]
}

resolve_model_dir() {
	local configured_dir="${OCR_MODEL_HOST_DIR:-}"
	local project_model_dir="$PROJECT_DIR/apps/server/models/ppocrv6"
	local paddlex_model_dir="${PADDLEX_HOME:-${HOME}/.paddlex}/official_models"

	if [[ -n "$configured_dir" ]]; then
		if [[ "$configured_dir" != /* ]]; then
			configured_dir="$OCR_DIR/$configured_dir"
		fi
		if has_ppocrv6_models "$configured_dir"; then
			printf '%s\n' "$configured_dir"
			return
		fi
		echo "PP-OCRv6 models are incomplete: $configured_dir" >&2
		exit 1
	fi

	if has_ppocrv6_models "$project_model_dir"; then
		printf '%s\n' "$project_model_dir"
		return
	fi

	if has_ppocrv6_models "$paddlex_model_dir"; then
		printf '%s\n' "$paddlex_model_dir"
		return
	fi

	echo "PP-OCRv6 medium models were not found." >&2
	echo "Set OCR_MODEL_HOST_DIR to a directory containing PP-OCRv6_medium_det and PP-OCRv6_medium_rec." >&2
	exit 1
}

OCR_IMAGE="${OCR_IMAGE:-xiaosongshu-ppocrv6:3.7.0}"
OCR_IMAGE_ARCHIVE="${OCR_IMAGE_ARCHIVE:-$OCR_DIR/xiaosongshu-ppocrv6-3.7.0-amd64.tar}"

set_compose_model_dir() {
	local configured_dir="${OCR_MODEL_HOST_DIR:-$OCR_DIR}"
	if [[ "$configured_dir" != /* ]]; then
		configured_dir="$OCR_DIR/$configured_dir"
	fi
	export OCR_MODEL_HOST_DIR="$configured_dir"
}

compose() {
	docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

case "$ACTION" in
	up)
		export OCR_MODEL_HOST_DIR="$(resolve_model_dir)"
		echo "Using PP-OCRv6 models: $OCR_MODEL_HOST_DIR"
		compose up -d ocr
		;;
	build|save)
		set_compose_model_dir
		compose build ocr
		docker image save --output "$OCR_IMAGE_ARCHIVE" "$OCR_IMAGE"
		echo "Saved OCR image: $OCR_IMAGE_ARCHIVE"
		;;
	load)
		docker image load --input "$OCR_IMAGE_ARCHIVE"
		;;
	down|stop)
		set_compose_model_dir
		compose down
		;;
	logs)
		set_compose_model_dir
		compose logs -f --tail=120 ocr
		;;
	ps|status)
		set_compose_model_dir
		compose ps ocr
		;;
	*)
		echo "Usage: $0 {build|load|up|down|logs|ps}" >&2
		exit 2
		;;
esac
