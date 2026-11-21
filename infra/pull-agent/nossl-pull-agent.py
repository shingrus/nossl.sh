#!/usr/bin/env python3
"""Pull public openipdata.org MMDBs and the ASN SQLite export atomically."""

from __future__ import annotations

import argparse
import os
import re
import shutil
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
RELOAD_URL = "http://127.0.0.1:8080/api/reload"
RELOAD_TIMEOUT_SECONDS = 5.0
DOWNLOAD_TIMEOUT_SECONDS = 120.0
MAX_FOLDER_LOOKBACK = 14
DEFAULT_BUCKET = "openipdata-dbs"
RELEASE_BASE_URL = "https://github.com/shingrus/openipdata.org/releases/latest/download"
DATASET_ASSETS = {
    "ip2geo": "openipdata-org-ip2geo.mmdb",
    "ip2asn": "openipdata-org-ip2asn.mmdb",
}


@dataclass(frozen=True)
class ReleaseAsset:
    url: str
    size: int
    validator: str


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
            folder_name = str(entry.get("Prefix") or "").strip("/")
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


def build_sqlite_key(folder: str) -> str:
    return f"{folder}/asn.sqlite3"


def get_required_r2_object(client: Any, bucket: str, key: str) -> R2Object:
    try:
        response = client.head_object(Bucket=bucket, Key=key)
    except Exception as exc:
        raise RuntimeError(f"Expected object is missing: r2://{bucket}/{key}") from exc
    return R2Object(
        key=key,
        size=int(response.get("ContentLength") or 0),
        etag=str(response.get("ETag") or "").strip('"'),
    )


def find_latest_sqlite_folder(client: Any, bucket: str, folders: list[str]) -> Optional[str]:
    for folder in reversed(folders[-MAX_FOLDER_LOOKBACK:]):
        try:
            get_required_r2_object(
                client=client,
                bucket=bucket,
                key=build_sqlite_key(folder),
            )
        except RuntimeError:
            continue
        return folder
    return None


def build_asset_url(dataset: str) -> str:
    asset_name = DATASET_ASSETS.get(dataset)
    if asset_name is None:
        raise RuntimeError(f"Unsupported dataset: {dataset!r}")
    return f"{RELEASE_BASE_URL}/{asset_name}"


def request_headers() -> dict[str, str]:
    return {"User-Agent": "nossl-pull-agent/1.0"}


def get_response_validator(headers) -> str:
    etag = str(headers.get("ETag") or "").strip().strip('"')
    if etag:
        return f"etag:{etag}"

    last_modified = str(headers.get("Last-Modified") or "").strip()
    if last_modified:
        return f"last-modified:{last_modified}"

    return ""


def response_matches_validator(headers, validator: str) -> bool:
    if validator.startswith("etag:"):
        etag = str(headers.get("ETag") or "").strip().strip('"')
        return etag == validator[len("etag:"):]
    if validator.startswith("last-modified:"):
        last_modified = str(headers.get("Last-Modified") or "").strip()
        return last_modified == validator[len("last-modified:"):]
    return False


def get_required_release_asset(dataset: str) -> ReleaseAsset:
    url = build_asset_url(dataset)
    request = urllib_request.Request(url, headers=request_headers(), method="HEAD")
    try:
        with urllib_request.urlopen(request, timeout=DOWNLOAD_TIMEOUT_SECONDS) as response:
            size = int(response.headers.get("Content-Length") or 0)
            validator = get_response_validator(response.headers)
    except Exception as exc:
        raise RuntimeError(f"Failed to inspect release asset {url}: {exc}") from exc

    if not validator:
        raise RuntimeError(f"Release asset has no ETag or Last-Modified header: {url}")

    return ReleaseAsset(url=url, size=size, validator=validator)


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


def create_temp_file(temp_dir: Path, dataset: str) -> Path:
    fd, temp_path = tempfile.mkstemp(
        prefix=temp_prefix_for(dataset),
        suffix=temp_suffix_for(dataset),
        dir=str(temp_dir),
    )
    os.close(fd)
    return Path(temp_path)


def download_release_asset_to_temp(
    remote: ReleaseAsset, temp_dir: Path, dataset: str
) -> Path:
    temp_file = create_temp_file(temp_dir, dataset)
    try:
        request = urllib_request.Request(remote.url, headers=request_headers())
        with urllib_request.urlopen(request, timeout=DOWNLOAD_TIMEOUT_SECONDS) as response:
            if not response_matches_validator(response.headers, remote.validator):
                raise RuntimeError("release asset changed while it was being downloaded")
            with temp_file.open("wb") as output:
                shutil.copyfileobj(response, output, length=1024 * 1024)
    except Exception as exc:
        temp_file.unlink(missing_ok=True)
        raise RuntimeError(f"Failed to download release asset {remote.url}: {exc}") from exc

    return temp_file


def download_r2_object_to_temp(
    client: Any, bucket: str, key: str, temp_dir: Path, dataset: str
) -> Path:
    temp_file = create_temp_file(temp_dir, dataset)
    try:
        client.download_file(bucket, key, str(temp_file))
    except Exception as exc:
        temp_file.unlink(missing_ok=True)
        raise RuntimeError(f"Failed to download r2://{bucket}/{key}: {exc}") from exc
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


def install_downloaded_file(
    temp_file: Path,
    target: PullTarget,
    expected_size: int,
    validator: str,
    dry_run: bool,
) -> bool:
    try:
        validate_download(
            path=temp_file,
            min_size_bytes=min_size_bytes_for(target.dataset),
            expected_size=expected_size,
        )
        if dry_run:
            log(
                f"[{target.dataset}] dry-run: validated download and "
                f"skipped install: {target.target_path}"
            )
            return False

        install_atomically(temp_file, target.target_path)
        if validator:
            write_installed_etag(target.target_path, validator)
        log(f"[{target.dataset}] installed: {target.target_path}")
        return True
    finally:
        temp_file.unlink(missing_ok=True)


def sync_release_asset_to_target(
    target: PullTarget,
    dry_run: bool,
) -> bool:
    selected = get_required_release_asset(target.dataset)
    log(
        f"[{target.dataset}] selected asset: {selected.url} "
        f"({selected.size or 'unknown'} bytes, {selected.validator})"
    )
    if (
        target.target_path.is_file()
        and read_installed_etag(target.target_path) == selected.validator
    ):
        log(f"[{target.dataset}] unchanged (validator match): {target.target_path}")
        return False

    cleanup_stale_temp_files(target.target_path.parent, target.dataset)
    temp_file = download_release_asset_to_temp(
        remote=selected,
        temp_dir=target.target_path.parent,
        dataset=target.dataset,
    )
    return install_downloaded_file(
        temp_file=temp_file,
        target=target,
        expected_size=selected.size,
        validator=selected.validator,
        dry_run=dry_run,
    )


def sync_sqlite_to_target(
    client: Any,
    bucket: str,
    latest_folder: str,
    target: PullTarget,
    dry_run: bool,
) -> bool:
    key = build_sqlite_key(latest_folder)
    selected = get_required_r2_object(client=client, bucket=bucket, key=key)
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
    temp_file = download_r2_object_to_temp(
        client=client,
        bucket=bucket,
        key=selected.key,
        temp_dir=target.target_path.parent,
        dataset=target.dataset,
    )
    return install_downloaded_file(
        temp_file=temp_file,
        target=target,
        expected_size=selected.size,
        validator=selected.etag,
        dry_run=dry_run,
    )


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
            "Download the latest GeoLite2-compatible ip2geo/ip2asn MMDB files "
            "from openipdata.org GitHub Releases and the ASN SQLite database "
            "from Cloudflare R2."
        )
    )
    parser.add_argument("--target", help="Backward-compatible alias for --geo-target")
    parser.add_argument("--geo-target", help="Target MMDB file path for ip2geo")
    parser.add_argument("--asn-target", help="Target MMDB file path for ip2asn")
    parser.add_argument(
        "--asn-sqlite-target",
        help="Target SQLite file path for the ASN detail database",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Run normal checks/download flow, but skip install",
    )

    return parser.parse_args(argv)


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

    r2_client = None
    r2_bucket = None
    sqlite_folder = None
    if any(target.dataset == "asn-sqlite" for target in targets):
        raw_r2 = os.getenv("R2") or ""
        if not raw_r2.strip():
            eprint("R2 is required when --asn-sqlite-target is set")
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

        try:
            client_config = Config(
                request_checksum_calculation="when_required",
                response_checksum_validation="when_required",
            )
        except TypeError:
            client_config = None
        r2_client = boto3.client(
            "s3",
            region_name="auto",
            endpoint_url=r2.endpoint_url,
            aws_access_key_id=r2.access_key,
            aws_secret_access_key=r2.secret_key,
            config=client_config,
        )
        r2_bucket = r2.bucket
        folders = list_date_folders(r2_client, r2_bucket)
        if not folders:
            eprint(f"No YYYY-MM-DD folders found in r2://{r2_bucket}/")
            return 1
        sqlite_folder = find_latest_sqlite_folder(r2_client, r2_bucket, folders)

    failed = False
    installed_by_dataset: dict[str, bool] = {}
    for target in targets:
        if target.dataset == "asn-sqlite" and sqlite_folder is None:
            eprint(
                f"[{target.dataset}] no file in the last {MAX_FOLDER_LOOKBACK} date folders "
                f"of r2://{r2_bucket}/"
            )
            failed = True
            continue

        try:
            if target.dataset == "asn-sqlite":
                log(f"[{target.dataset}] latest date folder: {sqlite_folder}")
                installed = sync_sqlite_to_target(
                    client=r2_client,
                    bucket=r2_bucket,
                    latest_folder=sqlite_folder,
                    target=target,
                    dry_run=args.dry_run,
                )
            else:
                installed = sync_release_asset_to_target(target=target, dry_run=args.dry_run)
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
