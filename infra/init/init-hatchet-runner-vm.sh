#!/usr/bin/env bash
# Prepare an Ubuntu (x86_64) VM to run the nossl Hatchet worker, and build and
# install the worker from this checkout.
# Run from a checkout of this repo: sudo bash infra/init/init-hatchet-runner-vm.sh
# Idempotent: re-run after `git pull` to redeploy; never overwrites an existing env file.
set -euo pipefail

RUN_AS="${RUN_AS:-nossl}"
APP_ROOT="${APP_ROOT:-/opt/nossl}"
BIN_DIR="${BIN_DIR:-$APP_ROOT/bin}"
DATA_DIR="${DATA_DIR:-/var/lib/nossl}"
ETC_DIR="${ETC_DIR:-/etc/nossl}"
ENV_FILE="${ENV_FILE:-$ETC_DIR/worker.env}"
SERVICE_NAME="${SERVICE_NAME:-nossl-worker}"
WORKER_BIN="${WORKER_BIN:-$BIN_DIR/nossl-worker}"

# Go toolchain used only for the build, in a temp dir that is removed afterwards.
GO_VERSION="${GO_VERSION:-1.27.3}"
GO_SHA256="${GO_SHA256:-65efbc80fdc1fa2cd2631cad5b481777a68e8725f34e89f50fc6ac714e379b40}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKER_SRC="$(cd "$SCRIPT_DIR/../hatchet" && pwd)"
BUILD_TMP=""
trap '[[ -n "$BUILD_TMP" ]] && rm -rf "$BUILD_TMP"' EXIT

log() {
    printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"
}

fail() {
    log "error: $*"
    exit 1
}

require_root() {
    if [[ "${EUID}" -ne 0 ]]; then
        fail "run this script as root"
    fi
}

require_platform() {
    command -v apt-get >/dev/null 2>&1 || fail "apt-get not found; this script targets Ubuntu/Debian"
    [[ "$(uname -m)" == "x86_64" ]] || fail "unsupported architecture $(uname -m); x86_64 required"
    for template in "$SCRIPT_DIR/$SERVICE_NAME.env.example" "$SCRIPT_DIR/$SERVICE_NAME.service"; do
        [[ -f "$template" ]] || fail "missing template next to this script: $template"
    done
}

install_packages() {
    log "installing OS packages"
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -q
    # git: the worker clones ipverse/asn-ip into the data dir. curl: Go download.
    apt-get install -y -q --no-install-recommends ca-certificates curl git
}

ensure_user() {
    if ! getent group "$RUN_AS" >/dev/null 2>&1; then
        log "creating group: $RUN_AS"
        groupadd --system "$RUN_AS"
    fi
    if ! id -u "$RUN_AS" >/dev/null 2>&1; then
        log "creating user: $RUN_AS"
        useradd --system --gid "$RUN_AS" --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$RUN_AS"
    fi
}

install_layout() {
    log "creating directories"
    install -d -m 0755 -o root -g root "$APP_ROOT" "$BIN_DIR"
    install -d -m 0750 -o root -g "$RUN_AS" "$ETC_DIR"
    # Worker state (source clones, build outputs); the worker creates its subdirectories.
    install -d -m 0750 -o "$RUN_AS" -g "$RUN_AS" "$DATA_DIR"
}

build_worker() {
    BUILD_TMP="$(mktemp -d)"
    local tmp="$BUILD_TMP"

    log "downloading Go $GO_VERSION"
    curl -fsSL --retry 3 -o "$tmp/go.tar.gz" "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz"
    echo "$GO_SHA256  $tmp/go.tar.gz" | sha256sum --check --status || fail "Go download checksum mismatch"
    tar -C "$tmp" -xzf "$tmp/go.tar.gz"

    log "building nossl-worker from $WORKER_SRC"
    (
        cd "$WORKER_SRC"
        GOTOOLCHAIN=local GOPATH="$tmp/gopath" GOCACHE="$tmp/cache" CGO_ENABLED=0 \
            "$tmp/go/bin/go" build -buildvcs=false -trimpath -ldflags "-s -w" -o "$tmp/nossl-worker" ./cmd/nossl-worker
    )
    install -m 0755 -o root -g root "$tmp/nossl-worker" "$WORKER_BIN"
    log "installed $WORKER_BIN"
}

install_env_file() {
    if [[ -f "$ENV_FILE" ]]; then
        log "keeping existing $ENV_FILE"
        return
    fi
    log "installing env template: $ENV_FILE"
    install -m 0640 -o root -g "$RUN_AS" "$SCRIPT_DIR/$SERVICE_NAME.env.example" "$ENV_FILE"
}

install_service() {
    log "installing systemd unit: $SERVICE_NAME"
    install -m 0644 -o root -g root \
        "$SCRIPT_DIR/$SERVICE_NAME.service" \
        "/etc/systemd/system/$SERVICE_NAME.service"
    systemctl daemon-reload
    systemctl enable "$SERVICE_NAME" >/dev/null
}

env_has_token() {
    grep -Eq '^HATCHET_CLIENT_TOKEN=.+' "$ENV_FILE"
}

maybe_start_service() {
    if ! env_has_token; then
        log "HATCHET_CLIENT_TOKEN is empty in $ENV_FILE; service enabled but not started"
        return
    fi
    log "restarting $SERVICE_NAME"
    systemctl restart "$SERVICE_NAME"
}

main() {
    require_root
    require_platform

    install_packages
    ensure_user
    install_layout
    build_worker
    install_env_file
    install_service
    maybe_start_service

    log "provisioning complete"
    log "next steps:"
    log "  1. Fill in secrets: sudoedit $ENV_FILE"
    log "  2. Start it: systemctl restart $SERVICE_NAME && journalctl -u $SERVICE_NAME -f"
}

main "$@"
