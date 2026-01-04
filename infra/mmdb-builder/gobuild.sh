#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_PATH="${1:-$SCRIPT_DIR/build_mmdb}"

cd "$SCRIPT_DIR"
go build -o "$OUT_PATH" ./build_mmdb.go

# go mod tidy
#go mod init nossl.sh/buildmmdb