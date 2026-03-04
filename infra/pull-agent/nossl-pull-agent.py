#!/usr/bin/env python3
"""
Pull the latest artifacts from S3 and install them atomically.

Selection logic:
1) List top-level date folders matching YYYY-MM-DD.
2) Pick the latest date folder.
3) Build expected filenames from the latest folder date:
   `ip2geo-nossl-sh-<YYYYMMDD>.mmdb`, `ip2asn-nossl-sh-<YYYYMMDD>.mmdb`,
   and/or `asn.sqlite3`.
4) Download each only when target file size differs, then atomically replace target.
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
MIN_MMDB_SIZE_BYTES = 1024 * 1024
MIN_ASN_SQLITE_SIZE_BYTES = 40 * 1024 * 1024
INSTALL_MODE = 0o644
SUPPORTED_DATASETS = ("ip2geo", "ip2asn", "asn-sqlite")


@dataclass(frozen=True)
class S3Object:
    key: str
    size: int


@dataclass(frozen=True)
class PullTarget:
    dataset: str
    target_path: Path


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


def build_expected_key(latest_folder: str, dataset: str) -> str:
    if dataset == "asn-sqlite":
        return f"{latest_folder}/asn.sqlite3"

    if dataset in ("ip2geo", "ip2asn"):
        folder_date = parse_date_folder(latest_folder)
        if folder_date is None:
            raise RuntimeError(f"Invalid latest date folder: {latest_folder!r}")
        date_tag = folder_date.strftime("%Y%m%d")
        return f"{latest_folder}/{dataset}-nossl-sh-{date_tag}.mmdb"

    raise RuntimeError(f"Unsupported dataset: {dataset!r}")


def get_required_object(client: Any, bucket: str, key: str) -> S3Object:
    try:
        response = client.head_object(Bucket=bucket, Key=key)
    except Exception as exc:
        raise RuntimeError(f"Expected object is missing: s3://{bucket}/{key}") from exc
    return S3Object(
        key=key,
        size=int(response.get("ContentLength") or 0),
    )


def temp_prefix_for(dataset: str) -> str:
    return f".{dataset}-pull-"


def temp_suffix_for(dataset: str) -> str:
    if dataset in ("ip2geo", "ip2asn"):
        return ".mmdb"
    if dataset == "asn-sqlite":
        return ".sqlite3"
    raise RuntimeError(f"Unsupported dataset: {dataset!r}")


def min_size_bytes_for(dataset: str) -> int:
    if dataset in ("ip2geo", "ip2asn"):
        return MIN_MMDB_SIZE_BYTES
    if dataset == "asn-sqlite":
        return MIN_ASN_SQLITE_SIZE_BYTES
    raise RuntimeError(f"Unsupported dataset: {dataset!r}")


def download_object_to_temp(
    client: Any, bucket: str, key: str, temp_dir: Path, dataset: str
) -> Path:
    fd, temp_path = tempfile.mkstemp(
        prefix=temp_prefix_for(dataset),
        suffix=temp_suffix_for(dataset),
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


def cleanup_stale_temp_files(temp_dir: Path, dataset: str) -> None:
    temp_prefix = temp_prefix_for(dataset)
    temp_suffix = temp_suffix_for(dataset)
    for path in temp_dir.glob(f"{temp_prefix}*{temp_suffix}"):
        if path.is_file():
            path.unlink(missing_ok=True)


def validate_target_path(path: Path) -> None:
    if not path.parent.is_dir():
        raise RuntimeError(f"Target directory does not exist: {path.parent}")


def sync_dataset_to_target(
    client: Any,
    bucket: str,
    latest_folder: str,
    target: PullTarget,
    dry_run: bool,
) -> None:
    expected_key = build_expected_key(latest_folder, target.dataset)
    selected = get_required_object(client=client, bucket=bucket, key=expected_key)
    log(
        f"[{target.dataset}] selected object: s3://{bucket}/{selected.key} "
        f"({selected.size} bytes)"
    )
    if target.target_path.is_file() and target.target_path.stat().st_size == selected.size:
        log(
            f"[{target.dataset}] skip download: target already has matching size "
            f"({selected.size} bytes): {target.target_path}"
        )
        return

    cleanup_stale_temp_files(target.target_path.parent, target.dataset)
    temp_file = download_object_to_temp(
        client=client,
        bucket=bucket,
        key=selected.key,
        temp_dir=target.target_path.parent,
        dataset=target.dataset,
    )
    try:
        validate_download(
            path=temp_file,
            min_size_bytes=min_size_bytes_for(target.dataset),
            expected_size=selected.size,
        )
        if dry_run:
            log(
                f"[{target.dataset}] dry-run: validated download and "
                f"skipped install: {target.target_path}"
            )
            return

        install_atomically(temp_file, target.target_path)
        log(f"[{target.dataset}] installed: {target.target_path}")
    finally:
        temp_file.unlink(missing_ok=True)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Download latest ip2geo/ip2asn MMDB files and asn.sqlite3 from "
            "S3 date folders and install them atomically."
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
    parser.add_argument("--target", help="Backward-compatible alias for --geo-target")
    parser.add_argument("--geo-target", help="Target MMDB file path for ip2geo")
    parser.add_argument("--asn-target", help="Target MMDB file path for ip2asn")
    parser.add_argument(
        "--asn-sqlite-target",
        help="Target SQLite file path for asn.sqlite3",
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
    geo_target_arg = args.geo_target or args.target
    targets: list[PullTarget] = []

    if geo_target_arg:
        geo_target = Path(geo_target_arg).expanduser().resolve()
        targets.append(PullTarget(dataset="ip2geo", target_path=geo_target))
    if args.asn_target:
        asn_target = Path(args.asn_target).expanduser().resolve()
        targets.append(PullTarget(dataset="ip2asn", target_path=asn_target))
    if args.asn_sqlite_target:
        asn_sqlite_target = Path(args.asn_sqlite_target).expanduser().resolve()
        targets.append(PullTarget(dataset="asn-sqlite", target_path=asn_sqlite_target))
    if not targets:
        eprint(
            "At least one target is required: --geo-target/--target, "
            "--asn-target, and/or --asn-sqlite-target"
        )
        return 2

    try:
        for target in targets:
            validate_target_path(target.target_path)
    except RuntimeError as exc:
        eprint(str(exc))
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

    try:
        for target in targets:
            sync_dataset_to_target(
                client=client,
                bucket=args.bucket,
                latest_folder=latest_folder,
                target=target,
                dry_run=args.dry_run,
            )
        return 0
    except RuntimeError as exc:
        eprint(str(exc))
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
