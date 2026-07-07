#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SCRAPER_DIR="${BOSS_SCRAPER_DIR:-$SERVER_DIR/tools/boss-zhipin-scraper}"
SCRAPER_SCRIPT="${BOSS_SCRAPER_SCRIPT_PATH:-$SCRAPER_DIR/scripts/boss_cdp_raw.py}"
PYTHON_BIN="${BOSS_SCRAPER_PYTHON:-$SERVER_DIR/.venv/bin/python}"
PROXY_SCRIPT="$SCRIPT_DIR/wsl-cdp-proxy.py"
DIAGNOSE_SCRIPT="$SCRIPT_DIR/diagnose-boss-scraper.py"
RUNTIME_DIR="$SERVER_DIR/data/salary-scraper"

if [[ ! -f "$SCRAPER_SCRIPT" ]]; then
	echo "boss-zhipin-scraper is not installed: $SCRAPER_SCRIPT" >&2
	echo "Run: pnpm --filter @xiaosongshu/server download:boss-scraper" >&2
	exit 1
fi

if [[ ! -x "$PYTHON_BIN" ]]; then
	PYTHON_BIN="python3"
fi

is_wsl() {
	grep -qi "microsoft\\|wsl" /proc/version 2>/dev/null
}

has_arg() {
	local target="$1"
	shift
	for arg in "$@"; do
		[[ "$arg" == "$target" ]] && return 0
	done
	return 1
}

arg_value() {
	local name="$1"
	local fallback="$2"
	shift 2
	while [[ $# -gt 0 ]]; do
		if [[ "$1" == "$name" && $# -ge 2 ]]; then
			echo "$2"
			return 0
		fi
		shift
	done
	echo "$fallback"
}

http_ok() {
	local url="$1"
	if command -v curl >/dev/null 2>&1; then
		curl --noproxy "*" -fsS --max-time 2 "$url" >/dev/null 2>&1
		return $?
	fi
	"$PYTHON_BIN" - "$url" <<'PY' >/dev/null 2>&1
import sys
import urllib.request

try:
    urllib.request.urlopen(sys.argv[1], timeout=2).read(1)
except Exception:
    raise SystemExit(1)
PY
}

find_windows_chrome() {
	if [[ -n "${WINDOWS_CHROME_PATH:-}" && -f "$WINDOWS_CHROME_PATH" ]]; then
		echo "$WINDOWS_CHROME_PATH"
		return 0
	fi
	for candidate in \
		"/mnt/c/Program Files/Google/Chrome/Application/chrome.exe" \
		"/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe"; do
		if [[ -f "$candidate" ]]; then
			echo "$candidate"
			return 0
		fi
	done
	return 1
}

windows_profile_dir() {
	if [[ -n "${BOSS_SCRAPER_WINDOWS_PROFILE_DIR:-}" ]]; then
		echo "$BOSS_SCRAPER_WINDOWS_PROFILE_DIR"
		return 0
	fi
	powershell.exe -NoProfile -Command "[Console]::OutputEncoding=[Text.UTF8Encoding]::UTF8; Join-Path \$env:USERPROFILE '.boss-zhipin-scraper\\chrome-profile'" 2>/dev/null | tr -d '\r'
}

windows_host_ip() {
	ip route show default 2>/dev/null | awk '{print $3; exit}'
}

windows_local_cdp_ok() {
	local port="$1"
	powershell.exe -NoProfile -Command "try { [void](Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://127.0.0.1:$port/json/version); exit 0 } catch { exit 1 }" >/dev/null 2>&1
}

ensure_windows_cdp_relay() {
	local chrome_port="$1"
	local relay_port="$2"
	local host_ip="$3"
	local relay_script_win
	if http_ok "http://$host_ip:$relay_port/json/version"; then
		return 0
	fi
	if ! windows_local_cdp_ok "$chrome_port"; then
		return 1
	fi
	relay_script_win="$(wslpath -w "$SCRIPT_DIR/windows-cdp-relay.ps1")"
	mkdir -p "$RUNTIME_DIR"
	nohup powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$relay_script_win" -ListenPort "$relay_port" -TargetHost "127.0.0.1" -TargetPort "$chrome_port" >"$RUNTIME_DIR/windows-cdp-relay-$chrome_port.log" 2>&1 &
	sleep 1
	http_ok "http://$host_ip:$relay_port/json/version"
}

ensure_wsl_cdp_proxy() {
	local port="$1"
	local host_ip
	local target_port
	host_ip="$(windows_host_ip)"
	if [[ -z "$host_ip" ]]; then
		return 1
	fi
	target_port="$port"
	if ! http_ok "http://$host_ip:$target_port/json/version"; then
		target_port=$((port + 10000))
		if ! ensure_windows_cdp_relay "$port" "$target_port" "$host_ip"; then
			return 1
		fi
	fi
	if http_ok "http://127.0.0.1:$port/json/version"; then
		return 0
	fi

	mkdir -p "$RUNTIME_DIR"
	local pid_file="$RUNTIME_DIR/wsl-cdp-proxy-$port.pid"
	local log_file="$RUNTIME_DIR/wsl-cdp-proxy-$port.log"
	if [[ -f "$pid_file" ]] && kill -0 "$(cat "$pid_file")" >/dev/null 2>&1; then
		return 0
	fi

	nohup "$PYTHON_BIN" "$PROXY_SCRIPT" "$port" "$host_ip" "$target_port" >"$log_file" 2>&1 &
	echo "$!" >"$pid_file"
	sleep 1
	http_ok "http://127.0.0.1:$port/json/version"
}

setup_windows_chrome_from_wsl() {
	local port login_timeout chrome_path profile_dir
	port="$(arg_value --cdp-port 9222 "$@")"
	login_timeout="$(arg_value --login-timeout 300 "$@")"
	chrome_path="$(find_windows_chrome)" || {
		echo "Windows Chrome not found. Set WINDOWS_CHROME_PATH to chrome.exe." >&2
		return 1
	}
	profile_dir="$(windows_profile_dir)"
	if [[ -z "$profile_dir" ]]; then
		echo "Cannot resolve Windows user profile path." >&2
		return 1
	fi

	echo "WSL detected; launching Windows Chrome:"
	echo "  $chrome_path"
	echo "  profile: $profile_dir"
	"$chrome_path" \
		"--remote-debugging-port=$port" \
		"--remote-debugging-address=0.0.0.0" \
		"--user-data-dir=$profile_dir" \
		"--no-first-run" \
		"--no-default-browser-check" \
		"--remote-allow-origins=*" \
		"https://www.zhipin.com/web/user/" >/dev/null 2>&1 &

	echo -n "Waiting for Chrome CDP on port $port"
	for _ in $(seq 1 30); do
		if http_ok "http://127.0.0.1:$port/json/version" || ensure_wsl_cdp_proxy "$port"; then
			echo
			echo "Chrome CDP is ready. Please log in to zhipin.com in the opened Windows Chrome."
			if has_arg --no-wait-login "$@" || [[ "${BOSS_SCRAPER_WSL_WAIT_LOGIN:-false}" != "true" ]]; then
				echo "After logging in, run: pnpm boss-scraper:check"
				return 0
			fi
			echo -n "Waiting for BOSS login"
			local deadline=$((SECONDS + login_timeout))
			while (( SECONDS < deadline )); do
				if "$PYTHON_BIN" "$SCRAPER_SCRIPT" --check --cdp-port "$port" >/dev/null 2>&1; then
					echo
					echo "BOSS login is ready."
					return 0
				fi
				echo -n "."
				sleep 5
			done
			echo
			echo "Timed out waiting for BOSS login. Chrome remains open; log in and run pnpm boss-scraper:check." >&2
			return 1
		fi
		echo -n "."
		sleep 1
	done
	echo
	echo "Windows Chrome started, but WSL cannot reach CDP port $port." >&2
	return 1
}

if is_wsl; then
	port="$(arg_value --cdp-port 9222 "$@")"
	if has_arg --setup-chrome "$@"; then
		setup_windows_chrome_from_wsl "$@"
		exit $?
	fi
	ensure_wsl_cdp_proxy "$port" >/dev/null 2>&1 || true
fi

if has_arg --check "$@"; then
	set +e
	"$PYTHON_BIN" "$SCRAPER_SCRIPT" "$@"
	status=$?
	set -e
	if [[ "$status" -ne 0 ]]; then
		port="$(arg_value --cdp-port 9222 "$@")"
		"$PYTHON_BIN" "$DIAGNOSE_SCRIPT" "$SCRAPER_SCRIPT" "$port" || true
	fi
	exit "$status"
fi

exec "$PYTHON_BIN" "$SCRAPER_SCRIPT" "$@"
