#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="$DEPLOY_DIR/docker-compose.yml"
ENV_FILE="$DEPLOY_DIR/.env"
IMAGE_DIR="$DEPLOY_DIR/images"
IMAGE_MAP_FILE="$DEPLOY_DIR/image-map.tsv"
OUTPUT_FILE="$IMAGE_DIR/xiaosongshu-images.tar"

if [[ ! -f "$ENV_FILE" ]]; then
	ENV_FILE="$DEPLOY_DIR/.env.example"
fi

usage() {
	cat <<EOF
Usage: $0 [options]

Pack deploy/images/*.tar into one offline bundle.

The script reads image names from deploy/docker-compose.yml and requires one
matching tar file for each image. It never pulls from the network.

Options:
  -o, --output <file>       Output bundle path. Default: deploy/images/xiaosongshu-images.tar
  --compose-file <file>    Compose file path. Default: deploy/docker-compose.yml
  --env-file <file>        Compose env file path. Default: deploy/.env or deploy/.env.example
  --image-dir <dir>        Source image tar directory. Default: deploy/images
  --image-map <file>       Image map file. Default: deploy/image-map.tsv if it exists
  -h, --help               Show this help.
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
		--compose-file)
			COMPOSE_FILE="$2"
			shift 2
			;;
		--env-file)
			ENV_FILE="$2"
			shift 2
			;;
		--image-dir)
			IMAGE_DIR="$2"
			shift 2
			;;
		--image-map)
			IMAGE_MAP_FILE="$2"
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
	echo "Env file not found: $ENV_FILE" >&2
	exit 1
fi

if [[ ! -d "$IMAGE_DIR" ]]; then
	echo "Image directory not found: $IMAGE_DIR" >&2
	exit 1
fi

image_tar_name() {
	local image="$1"
	image="${image//\//_}"
	image="${image//:/_}"
	printf '%s.tar' "$image"
}

declare -A SOURCE_TAR_BY_IMAGE=()

if [[ -f "$IMAGE_MAP_FILE" ]]; then
	while IFS=$'\t' read -r image source_tar _rest; do
		if [[ -z "${image//[[:space:]]/}" || "$image" == \#* ]]; then
			continue
		fi
		if [[ -z "${source_tar//[[:space:]]/}" ]]; then
			echo "Invalid image map row for image: $image" >&2
			exit 1
		fi
		SOURCE_TAR_BY_IMAGE["$image"]="$source_tar"
	done < "$IMAGE_MAP_FILE"
fi

resolve_source_file() {
	local image="$1"
	local mapped_source="${SOURCE_TAR_BY_IMAGE[$image]:-}"
	local source_file=''

	if [[ -n "$mapped_source" ]]; then
		if [[ "$mapped_source" = /* ]]; then
			source_file="$mapped_source"
		else
			source_file="$IMAGE_DIR/$mapped_source"
		fi
	else
		source_file="$IMAGE_DIR/$(image_tar_name "$image")"
	fi

	printf '%s' "$source_file"
}

mapfile -t IMAGES < <(
	docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" config --images \
		| sed '/^[[:space:]]*$/d' \
		| sort -u
)

if [[ "${#IMAGES[@]}" -eq 0 ]]; then
	echo "No images found in compose file: $COMPOSE_FILE" >&2
	exit 1
fi

tmp_dir="$(mktemp -d)"
cleanup() {
	rm -rf "$tmp_dir"
}
trap cleanup EXIT

bundle_image_dir="$tmp_dir/images"
mkdir -p "$bundle_image_dir"

manifest_file="$tmp_dir/manifest.tsv"
: > "$manifest_file"

echo "Images from compose:"
printf '  %s\n' "${IMAGES[@]}"

for image in "${IMAGES[@]}"; do
	source_file="$(resolve_source_file "$image")"
	if [[ ! -f "$source_file" ]]; then
		expected_file="$IMAGE_DIR/$(image_tar_name "$image")"
		cat >&2 <<EOF
Missing offline image tar for compose image:
  $image

Expected default file:
  $expected_file

Or add a mapping row in:
  $IMAGE_MAP_FILE

  $image	$(basename "$source_file")

Current resolved source:
  $source_file
EOF
		exit 1
	fi

	target_name="$(image_tar_name "$image")"
	cp "$source_file" "$bundle_image_dir/$target_name"
	printf '%s\t%s\n' "$image" "images/$target_name" >> "$manifest_file"
done

mkdir -p "$(dirname "$OUTPUT_FILE")"
rm -f "$OUTPUT_FILE"
tar -C "$tmp_dir" -cf "$OUTPUT_FILE" manifest.tsv images

echo "Packed offline image bundle: $OUTPUT_FILE"
echo "Bundle manifest:"
sed 's/^/  /' "$manifest_file"
