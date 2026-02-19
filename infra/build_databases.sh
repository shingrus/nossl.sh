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
  --ips-db <path>
                      SQLite DB path for rdns_geo.py.
                      If omitted, rdns geo step is skipped.
  -h, --help          Show this help message.
EOF
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
WORK_DIR="${ROOT_DIR}"
IPS_DB=""

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
        --ips-db)
            if [[ $# -lt 2 ]]; then
                log "error: --ips-db requires a path"
                exit 2
            fi
            IPS_DB="$2"
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
require_cmd ln
BIN_DIR="${WORK_DIR}/bin"
BUILD_COMMAND="${BIN_DIR}/build_mmdb"
DATE_TAG="$(date +%Y%m%d)"
TEMP_DIR="${WORK_DIR}/.tmp-ipverse"
COUNTRY_REPO="${TEMP_DIR}/country-ip-blocks"
GEOFEED_DIR="${WORK_DIR}"
ASN_REPO="${TEMP_DIR}/asn-ip"

ASN_MMDB="${WORK_DIR}/ip2asn-nossl-sh-${DATE_TAG}.mmdb"
COUNTRY_MMDB="${WORK_DIR}/ip2geo-nossl-sh-${DATE_TAG}.mmdb"
ASN_SQLITE="${WORK_DIR}/asn.sqlite3"
ASN_LATEST_LINK="${WORK_DIR}/ip2asn-latest.mmdb"
COUNTRY_LATEST_LINK="${WORK_DIR}/ip2geo-latest.mmdb"
RDNS_GEO_SCRIPT="${BIN_DIR}/rdns_geo.py"
RDNS_GEOFEED_OUTPUT="${WORK_DIR}/rdns_geo.csv"
RDNS_UNMATCHED_OUTPUT="${WORK_DIR}/unmatched.txt"
RDNS_RULES_URL="https://raw.githubusercontent.com/shingrus/nossl.sh/refs/heads/main/infra/rdns_geo_rules.json"

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

update_symlink_to_latest() {
    local target_path="$1"
    local link_path="$2"
    local target_name

    if [[ ! -f "${target_path}" ]]; then
        log "error: cannot link missing file: ${target_path}"
        exit 4
    fi

    target_name="$(basename "${target_path}")"
    ln -sfn "${target_name}" "${link_path}"
    log "updated symlink: ${link_path} -> ${target_name}"
}

run_rdns_geo() {
    local mmdb_path="$1"

    if [[ -z "${IPS_DB}" ]]; then
        log "ips DB is not set; skipping rdns geo"
        return 0
    fi

    rm -f "${RDNS_GEOFEED_OUTPUT}" "${RDNS_UNMATCHED_OUTPUT}"

    if [[ ! -f "${RDNS_GEO_SCRIPT}" ]]; then
        log "warning: rdns geo script not found: ${RDNS_GEO_SCRIPT}; skipping"
        return 0
    fi
    if [[ ! -f "${IPS_DB}" ]]; then
        log "error: ips DB not found: ${IPS_DB}"
        exit 2
    fi
    if [[ ! -f "${mmdb_path}" ]]; then
        log "warning: geo mmdb not found for rdns geo: ${mmdb_path}; skipping"
        return 0
    fi

    log "running rdns geo"
    log "rdns geo mmdb: ${mmdb_path}"
    log "rdns geo rules: ${RDNS_RULES_URL}"
    python3 "${RDNS_GEO_SCRIPT}" \
        --db "${IPS_DB}" \
        --mmdb "${mmdb_path}" \
        --rules-url "${RDNS_RULES_URL}" \
        --output "${RDNS_GEOFEED_OUTPUT}" \
        --unmatched-zones "${RDNS_UNMATCHED_OUTPUT}"
}

patch_country_mmdb_with_rdns() {
    if [[ -z "${IPS_DB}" ]]; then
        return 0
    fi
    if [[ ! -f "${RDNS_GEOFEED_OUTPUT}" || ! -s "${RDNS_GEOFEED_OUTPUT}" ]]; then
        log "rdns geofeed output is empty; skipping patch"
        return 0
    fi

    log "patching country mmdb with rdns geofeed"
    ${BUILD_COMMAND} \
        --patch-mmdb "${COUNTRY_MMDB}" \
        --patch-geofeed "${RDNS_GEOFEED_OUTPUT}"
}

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

#build ip2geo mmdb
${BUILD_COMMAND} \
    --country-dir "${COUNTRY_REPO}/country" \
    --country-out "${COUNTRY_MMDB}" \
    --geofeed-dir "${GEOFEED_DIR}"
#build ip2asn mmdb
${BUILD_COMMAND} \
    --as-dir "${ASN_REPO}/as" \
    --asn-out "${ASN_MMDB}"

run_rdns_geo "${COUNTRY_MMDB}"
patch_country_mmdb_with_rdns

update_symlink_to_latest "${COUNTRY_MMDB}" "${COUNTRY_LATEST_LINK}"
update_symlink_to_latest "${ASN_MMDB}" "${ASN_LATEST_LINK}"

log "build complete"
log "output: ${ASN_MMDB}"
log "output: ${COUNTRY_MMDB}"
log "output: ${ASN_SQLITE}"
log "output: ${COUNTRY_LATEST_LINK}"
log "output: ${ASN_LATEST_LINK}"
