#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="${SERVICE_NAME:-dagster-cloud-agent}"
RUN_AS="${RUN_AS:-nossl}"
RUN_GROUP="${RUN_GROUP:-nossl}"
APP_ROOT="${APP_ROOT:-/opt/nossl}"
REPO_DIR="${REPO_DIR:-$APP_ROOT/repo}"
BIN_DIR="${BIN_DIR:-$APP_ROOT/bin}"
DAGSTER_HOME="${DAGSTER_HOME:-$APP_ROOT/dagster_home}"
VENV_DIR="${VENV_DIR:-$APP_ROOT/dagster-venv}"
WORK_DIR="${WORK_DIR:-/var/lib/nossl}"
ENV_FILE="${ENV_FILE:-/etc/dagster-agent.env}"
INITD_PATH="${INITD_PATH:-/etc/init.d/$SERVICE_NAME}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

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

require_cmd() {
    if ! command -v "$1" >/dev/null 2>&1; then
        fail "missing required command: $1"
    fi
}

ensure_group() {
    if ! getent group "$RUN_GROUP" >/dev/null 2>&1; then
        log "creating group: $RUN_GROUP"
        groupadd --system "$RUN_GROUP"
    fi
}

ensure_user() {
    if ! id -u "$RUN_AS" >/dev/null 2>&1; then
        log "creating user: $RUN_AS"
        useradd \
            --system \
            --gid "$RUN_GROUP" \
            --home-dir "$APP_ROOT" \
            --create-home \
            --shell /usr/sbin/nologin \
            "$RUN_AS"
    fi
}

copy_repo() {
    log "syncing repository into $REPO_DIR"
    install -d -o root -g root "$REPO_DIR"

    (
        cd "$SOURCE_ROOT"
        tar \
            --exclude='./.git' \
            --exclude='./.claude' \
            --exclude='./node_modules' \
            --exclude='./infra/.pdbcache' \
            --exclude='./infra/scripts/__pycache__' \
            --exclude='./infra/asn.sqlite3' \
            --exclude='./infra/*.mmdb' \
            --exclude='./counters.db' \
            -cf - .
    ) | tar -C "$REPO_DIR" -xf -
}

install_runtime_layout() {
    log "creating runtime directories"
    install -d -o root -g root "$APP_ROOT" "$REPO_DIR" "$BIN_DIR"
    install -d -o "$RUN_AS" -g "$RUN_GROUP" "$DAGSTER_HOME" "$WORK_DIR"
}

install_bin_tools() {
    log "installing dagster job scripts into /opt/nossl/bin"
    install -m 0755 -o root -g root "$REPO_DIR/infra/scripts/aggregate_asns.py" "$BIN_DIR/aggregate_asns.py"
    install -m 0755 -o root -g root "$REPO_DIR/infra/scripts/populate_asn_domains.py" "$BIN_DIR/populate_asn_domains.py"
    install -m 0755 -o root -g root "$REPO_DIR/infra/scripts/pdb_asn_geo.py" "$BIN_DIR/pdb_asn_geo.py"
    install -m 0755 -o root -g root "$REPO_DIR/infra/scripts/rdns_geo.py" "$BIN_DIR/rdns_geo.py"
}

install_config_templates() {
    if [[ ! -f "$DAGSTER_HOME/dagster.yaml" ]]; then
        log "installing dagster.yaml template"
        install -m 0640 -o "$RUN_AS" -g "$RUN_GROUP" \
            "$REPO_DIR/infra/init/dagster.yaml.example" \
            "$DAGSTER_HOME/dagster.yaml"
    else
        log "keeping existing $DAGSTER_HOME/dagster.yaml"
    fi

    if [[ ! -f "$ENV_FILE" ]]; then
        log "installing env file template: $ENV_FILE"
        install -m 0640 -o root -g "$RUN_GROUP" \
            "$REPO_DIR/infra/init/dagster-agent.env.example" \
            "$ENV_FILE"
    else
        log "keeping existing $ENV_FILE"
    fi
}

install_initd() {
    log "installing init.d wrapper: $INITD_PATH"
    install -m 0755 -o root -g root \
        "$REPO_DIR/infra/init/dagster-cloud-agent.initd" \
        "$INITD_PATH"
    update-rc.d "$SERVICE_NAME" defaults >/dev/null
}

main() {
    require_root
    require_cmd tar
    require_cmd install
    require_cmd update-rc.d
    require_cmd start-stop-daemon

    ensure_group
    ensure_user
    install_runtime_layout
    copy_repo
    install_bin_tools
    install_config_templates
    install_initd

    log "provisioning complete"
    log "next steps:"
    log "  1. Edit $DAGSTER_HOME/dagster.yaml"
    log "  2. Edit $ENV_FILE"
    log "  3. Start the service: service $SERVICE_NAME start"
}

main "$@"
