#!/usr/bin/env python3
"""
Pull the latest artifacts from Cloudflare R2 (S3-compatible API) and install
them atomically.

Selection logic:
1) List top-level date folders matching YYYY-MM-DD.
2) For each dataset, pick the latest date folder that contains its file, so a
   dataset published less often never blocks the others.
3) Expected filenames are built from that folder's date and --mmdb-name:
   `ip2geo-<name>-<YYYYMMDD>.mmdb`, `ip2asn-<name>-<YYYYMMDD>.mmdb`,
   and/or `asn.sqlite3`.
4) Download each only when the object's ETag differs from `<target>.etag`
   (or that file is missing), then atomically replace target and store the ETag.
5) With --dry-run, run the same logic, but skip install after successful download+validate.
6) After successful asn.sqlite3 install, POST /api/reload.

R2 location and credentials come from one environment variable (use a
read-only token):
  R2=https://<access-key-id>:<secret-access-key>@<account-id>.r2.cloudflarestorage.com/<bucket>
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
from urllib import request as urllib_request
from urllib.parse import unquote, urlsplit

DATE_FOLDER_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
MIN_MMDB_SIZE_BYTES = 1024 * 1024
MIN_ASN_SQLITE_SIZE_BYTES = 40 * 1024 * 1024
INSTALL_MODE = 0o644
SUPPORTED_DATASETS = ("ip2geo", "ip2asn", "asn-sqlite")
RELOAD_URL = "http://127.0.0.1:8080/api/reload"
RELOAD_TIMEOUT_SECONDS = 5.0
MAX_FOLDER_LOOKBACK = 14
DEFAULT_BUCKET = "openipdata-dbs"
DEFAULT_MMDB_NAME = "openipdata"


@dataclass(frozen=True)
class R2Object:
    key: str
    size: int
    etag: str


@dataclass(frozen=True)
class R2Config:
    endpoint_url: str
    access_key: str
    secret_key: str
    bucket: str


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


def parse_r2(raw: str) -> R2Config:
    parts = urlsplit(raw.strip())
    if parts.scheme != "https" or not parts.hostname:
        raise RuntimeError("R2 must be an https:// URL")
    access_key = unquote(parts.username or "")
    secret_key = unquote(parts.password or "")
    if not access_key or not secret_key:
        raise RuntimeError("R2 must include <access-key-id>:<secret-access-key>@")
    host = parts.hostname if parts.port is None else f"{parts.hostname}:{parts.port}"
    return R2Config(
        endpoint_url=f"https://{host}",
        access_key=access_key,
        secret_key=secret_key,
        bucket=parts.path.strip("/") or DEFAULT_BUCKET,
    )


def build_expected_key(latest_folder: str, dataset: str, mmdb_name: str) -> str:
    if dataset == "asn-sqlite":
        return f"{latest_folder}/asn.sqlite3"

    if dataset in ("ip2geo", "ip2asn"):
        folder_date = parse_date_folder(latest_folder)
        if folder_date is None:
            raise RuntimeError(f"Invalid latest date folder: {latest_folder!r}")
        date_tag = folder_date.strftime("%Y%m%d")
        return f"{latest_folder}/{dataset}-{mmdb_name}-{date_tag}.mmdb"

    raise RuntimeError(f"Unsupported dataset: {dataset!r}")


def get_required_object(client: Any, bucket: str, key: str) -> R2Object:
    try:
        response = client.head_object(Bucket=bucket, Key=key)
    except Exception as exc:
        raise RuntimeError(f"Expected object is missing: r2://{bucket}/{key}") from exc
    return R2Object(
        key=key,
        size=int(response.get("ContentLength") or 0),
        etag=str(response.get("ETag") or "").strip('"'),
    )


def find_latest_folder_with(
    client: Any, bucket: str, folders: list[str], dataset: str, mmdb_name: str
) -> Optional[str]:
    for folder in reversed(folders[-MAX_FOLDER_LOOKBACK:]):
        try:
            get_required_object(
                client=client, bucket=bucket, key=build_expected_key(folder, dataset, mmdb_name)
            )
        except RuntimeError:
            continue
        return folder
    return None


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


def etag_path_for(target_path: Path) -> Path:
    return target_path.with_name(f"{target_path.name}.etag")


def read_installed_etag(target_path: Path) -> str:
    try:
        return etag_path_for(target_path).read_text().strip()
    except FileNotFoundError:
        return ""


def write_installed_etag(target_path: Path, etag: str) -> None:
    etag_path = etag_path_for(target_path)
    temp_path = etag_path.with_name(f".{etag_path.name}.tmp")
    temp_path.write_text(f"{etag}\n")
    os.replace(str(temp_path), str(etag_path))


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
    mmdb_name: str,
    dry_run: bool,
) -> bool:
    expected_key = build_expected_key(latest_folder, target.dataset, mmdb_name)
    selected = get_required_object(client=client, bucket=bucket, key=expected_key)
    log(
        f"[{target.dataset}] selected object: r2://{bucket}/{selected.key} "
        f"({selected.size} bytes, etag {selected.etag or '-'})"
    )
    if (
        selected.etag
        and target.target_path.is_file()
        and read_installed_etag(target.target_path) == selected.etag
    ):
        log(f"[{target.dataset}] unchanged (etag match): {target.target_path}")
        return False

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
            return False

        install_atomically(temp_file, target.target_path)
        if selected.etag:
            write_installed_etag(target.target_path, selected.etag)
        log(f"[{target.dataset}] installed: {target.target_path}")
        return True
    finally:
        temp_file.unlink(missing_ok=True)


def post_reload() -> None:
    request = urllib_request.Request(
        url=RELOAD_URL,
        data=b"",
        method="POST",
    )
    try:
        with urllib_request.urlopen(request, timeout=RELOAD_TIMEOUT_SECONDS) as response:
            response_code = response.getcode()
    except Exception as exc:
        raise RuntimeError(f"Failed to call reload API at {RELOAD_URL}: {exc}") from exc

    if response_code < 200 or response_code >= 300:
        raise RuntimeError(f"Reload API failed with HTTP {response_code}")

    log(f"[reload] success: {RELOAD_URL}")


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Download latest ip2geo/ip2asn MMDB files and asn.sqlite3 from "
            "Cloudflare R2 date folders and install them atomically."
        )
    )
    parser.add_argument(
        "--mmdb-name",
        default=DEFAULT_MMDB_NAME,
        help=f"Name part of MMDB keys, <dataset>-<name>-<YYYYMMDD>.mmdb (default: {DEFAULT_MMDB_NAME})",
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

    raw_r2 = os.getenv("R2") or ""
    if not raw_r2.strip():
        eprint("R2 is required")
        return 2
    try:
        r2 = parse_r2(raw_r2)
    except RuntimeError as exc:
        eprint(str(exc))
        return 2

    try:
        import boto3
        from botocore.config import Config
    except ModuleNotFoundError:
        eprint("Missing boto3 dependency; install boto3 in the Python environment.")
        return 2

    # boto3 >= 1.36 adds default checksums that R2 can reject; older botocore
    # lacks these options and needs nothing.
    try:
        client_config = Config(
            request_checksum_calculation="when_required",
            response_checksum_validation="when_required",
        )
    except TypeError:
        client_config = None
    client = boto3.client(
        "s3",
        region_name="auto",
        endpoint_url=r2.endpoint_url,
        aws_access_key_id=r2.access_key,
        aws_secret_access_key=r2.secret_key,
        config=client_config,
    )

    folders = list_date_folders(client, r2.bucket)
    if not folders:
        eprint(f"No YYYY-MM-DD folders found in r2://{r2.bucket}/")
        return 1

    failed = False
    installed_by_dataset: dict[str, bool] = {}
    for target in targets:
        latest_folder = find_latest_folder_with(
            client, r2.bucket, folders, target.dataset, args.mmdb_name
        )
        if latest_folder is None:
            eprint(
                f"[{target.dataset}] no file in the last {MAX_FOLDER_LOOKBACK} date folders "
                f"of r2://{r2.bucket}/"
            )
            failed = True
            continue
        log(f"[{target.dataset}] latest date folder: {latest_folder}")
        try:
            installed = sync_dataset_to_target(
                client=client,
                bucket=r2.bucket,
                latest_folder=latest_folder,
                target=target,
                mmdb_name=args.mmdb_name,
                dry_run=args.dry_run,
            )
        except RuntimeError as exc:
            eprint(f"[{target.dataset}] {exc}")
            failed = True
            continue
        installed_by_dataset[target.dataset] = (
            installed_by_dataset.get(target.dataset, False) or installed
        )

    try:
        if not args.dry_run and installed_by_dataset.get("asn-sqlite", False):
            post_reload()
    except RuntimeError as exc:
        eprint(str(exc))
        return 1
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
