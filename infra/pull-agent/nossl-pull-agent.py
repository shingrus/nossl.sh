#!/usr/bin/env python3
"""
Pull the latest ip2geo MMDB artifact from S3 and install it atomically.

Selection logic:
1) List top-level date folders matching YYYY-MM-DD.
2) Pick the latest date folder.
3) Build expected filename `ip2geo-nossl-sh-<YYYYMMDD>.mmdb` from the latest folder date.
4) Download it only when target file size differs, then atomically replace target.
5) With --dry-run, run the same logic, but skip install after successful download+validate.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
import tempfile
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path
from typing import Any, Optional

DATE_FOLDER_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
MIN_SIZE_BYTES = 1024 * 1024
INSTALL_MODE = 0o644
TEMP_PREFIX = ".ip2geo-pull-"
TEMP_SUFFIX = ".mmdb"


@dataclass(frozen=True)
class S3Object:
    key: str
    size: int


def log(message: str) -> None:
    print(message)


def eprint(message: str) -> None:
    print(message, file=sys.stderr)


def parse_date_folder(raw: str) -> Optional[date]:
    if not DATE_FOLDER_RE.fullmatch(raw):
        return None
    try:
        return datetime.strptime(raw, "%Y-%m-%d").date()
    except ValueError:
        return None


def list_date_folders(client: Any, bucket: str) -> list[str]:
    paginator = client.get_paginator("list_objects_v2")
    folders: list[str] = []
    for page in paginator.paginate(Bucket=bucket, Delimiter="/"):
        for entry in page.get("CommonPrefixes", []):
            prefix = str(entry.get("Prefix") or "")
            folder_name = prefix.strip("/")
            if parse_date_folder(folder_name):
                folders.append(folder_name)

    folders.sort()
    return folders


def build_expected_key(latest_folder: str) -> str:
    folder_date = parse_date_folder(latest_folder)
    if folder_date is None:
        raise RuntimeError(f"Invalid latest date folder: {latest_folder!r}")
    date_tag = folder_date.strftime("%Y%m%d")
    return f"{latest_folder}/ip2geo-nossl-sh-{date_tag}.mmdb"


def get_required_object(client: Any, bucket: str, key: str) -> S3Object:
    try:
        response = client.head_object(Bucket=bucket, Key=key)
    except Exception as exc:
        raise RuntimeError(f"Expected object is missing: s3://{bucket}/{key}") from exc
    return S3Object(
        key=key,
        size=int(response.get("ContentLength") or 0),
    )


def download_object_to_temp(client: Any, bucket: str, key: str, temp_dir: Path) -> Path:
    fd, temp_path = tempfile.mkstemp(
        prefix=TEMP_PREFIX,
        suffix=TEMP_SUFFIX,
        dir=str(temp_dir),
    )
    os.close(fd)
    temp_file = Path(temp_path)

    try:
        client.download_file(bucket, key, str(temp_file))
    except Exception:
        temp_file.unlink(missing_ok=True)
        raise

    return temp_file


def validate_download(path: Path, min_size_bytes: int, expected_size: int) -> None:
    if not path.is_file():
        raise RuntimeError(f"downloaded file not found: {path}")

    actual_size = path.stat().st_size
    if actual_size < min_size_bytes:
        raise RuntimeError(
            f"downloaded file is too small: {actual_size} bytes < {min_size_bytes} bytes"
        )
    if expected_size > 0 and actual_size != expected_size:
        raise RuntimeError(
            f"downloaded file size mismatch: got {actual_size}, expected {expected_size}"
        )


def install_atomically(source_path: Path, target_path: Path) -> None:
    os.replace(str(source_path), str(target_path))
    os.chmod(target_path, INSTALL_MODE)


def cleanup_stale_temp_files(temp_dir: Path) -> None:
    for path in temp_dir.glob(f"{TEMP_PREFIX}*{TEMP_SUFFIX}"):
        if path.is_file():
            path.unlink(missing_ok=True)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Download the latest ip2geo MMDB from S3 date folders and "
            "install it atomically to --target."
        )
    )
    parser.add_argument(
        "--bucket",
        required=True,
        help="S3 bucket",
    )
    parser.add_argument(
        "--region",
        required=True,
        help="S3 region",
    )
    parser.add_argument(
        "--target",
        required=True,
        help="Target MMDB file path to install",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Run normal checks/download flow, but skip install",
    )

    args = parser.parse_args(argv)
    return args


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    target_path = Path(args.target).expanduser().resolve()
    if not target_path.parent.is_dir():
        eprint(f"Target directory does not exist: {target_path.parent}")
        return 2

    try:
        import boto3
    except ModuleNotFoundError:
        eprint("Missing boto3 dependency; install boto3 in the Python environment.")
        return 2

    client = boto3.client(
        "s3",
        region_name=args.region,
    )

    folders = list_date_folders(client, args.bucket)
    if not folders:
        eprint(f"No YYYY-MM-DD folders found in s3://{args.bucket}/")
        return 1

    latest_folder = folders[-1]
    log(f"latest date folder: {latest_folder}")

    expected_key = build_expected_key(latest_folder)
    selected = get_required_object(client=client, bucket=args.bucket, key=expected_key)
    log(f"selected object: s3://{args.bucket}/{selected.key} ({selected.size} bytes)")
    if target_path.is_file() and target_path.stat().st_size == selected.size:
        log(
            f"skip download: target already has matching size "
            f"({selected.size} bytes): {target_path}"
        )
        return 0

    cleanup_stale_temp_files(target_path.parent)
    temp_file = download_object_to_temp(
        client=client,
        bucket=args.bucket,
        key=selected.key,
        temp_dir=target_path.parent,
    )
    try:
        validate_download(
            path=temp_file,
            min_size_bytes=MIN_SIZE_BYTES,
            expected_size=selected.size,
        )
        if args.dry_run:
            log(f"dry-run: validated download and skipped install: {target_path}")
            return 0

        install_atomically(temp_file, target_path)
        log(f"installed: {target_path}")
        return 0
    finally:
        temp_file.unlink(missing_ok=True)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
