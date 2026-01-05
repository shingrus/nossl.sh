#!/usr/bin/env bash
set -euo pipefail

log() {
    printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"
}

require_cmd() {
    if ! command -v "$1" >/dev/null 2>&1; then
        log "error: missing required command: $1"
        exit 127
    fi
}

usage() {
    cat <<'EOF'
Usage: infra/build_databases.sh [--work-dir <path>]

Options:
  --work-dir <path>   Output directory for generated databases.
                      Temporary data is stored under <work-dir>/.tmp-ipverse.
  -h, --help          Show this help message.
EOF
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
WORK_DIR="${ROOT_DIR}"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --work-dir)
            if [[ $# -lt 2 ]]; then
                log "error: --work-dir requires a path"
                exit 2
            fi
            WORK_DIR="$2"
            shift 2
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            log "error: unknown argument: $1"
            usage
            exit 2
            ;;
    esac
done

require_cmd git
require_cmd go
require_cmd python3

BIN_DIR="${WORK_DIR}/bin"
BUILD_COMMAND="${BIN_DIR}/build_mmdb"
DATE_TAG="$(date +%Y%m%d)"
TEMP_DIR="${WORK_DIR}/.tmp-ipverse"
COUNTRY_REPO="${TEMP_DIR}/country-ip-blocks"
ASN_REPO="${TEMP_DIR}/asn-ip"

ASN_MMDB="${WORK_DIR}/ip-to-asn-nossl-sh-${DATE_TAG}.mmdb"
COUNTRY_MMDB="${WORK_DIR}/ip-to-country-nossl-sh-${DATE_TAG}.mmdb"
ASN_SQLITE="${WORK_DIR}/asn.sqlite3"

safe_remove_dir() {
    local target="$1"
    if [[ -z "${target}" || "${target}" == "/" ]]; then
        log "error: refusing to remove unsafe directory: ${target}"
        exit 3
    fi
    if [[ -d "${target}" ]]; then
        log "cleaning work dir: ${target}"
        rm -rf "${target}"
        log "cleaned work dir: ${target}"
    fi
}

cleanup() {
    safe_remove_dir "${TEMP_DIR}"
}
trap cleanup EXIT

log "starting mmdb build"
log "work dir: ${WORK_DIR}"
log "temp dir: ${TEMP_DIR}"
safe_remove_dir "${TEMP_DIR}"
mkdir -p "${WORK_DIR}"
mkdir -p "${TEMP_DIR}"

log "cloning country-ip-blocks"
git clone --depth 1 https://github.com/ipverse/country-ip-blocks "${COUNTRY_REPO}"

log "cloning asn-ip"
git clone --depth 1 --single-branch https://github.com/ipverse/asn-ip "${ASN_REPO}"

log "aggregating ASN SQLite"
python3 "${BIN_DIR}/aggregate_asns.py" \
    --as-dir "${ASN_REPO}/as" \
    --output "${ASN_SQLITE}"

log "building MMDBs"
rm -f "${ASN_MMDB}" "${COUNTRY_MMDB}"
#go run "${ROOT_DIR}/infra/mmdb-builder/build_mmdb.go" \
${BUILD_COMMAND} \
    --as-dir "${ASN_REPO}/as" \
    --country-dir "${COUNTRY_REPO}/country" \
    --asn-out "${ASN_MMDB}" \
    --country-out "${COUNTRY_MMDB}"

log "build complete"
log "output: ${ASN_MMDB}"
log "output: ${COUNTRY_MMDB}"
log "output: ${ASN_SQLITE}"
