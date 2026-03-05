from dagster import op, job, in_process_executor
import subprocess
from pathlib import Path

from infra.dagster.common_ops import build_date_tag, upload_file_to_s3
from infra.dagster.concurrency_tags import GEO_GUARD_PDB_TAG_KEY, GEO_GUARD_TAG_VALUE
from infra.dagster.utils import (
    get_work_and_bin_dirs,
    get_work_dir,
    make_temp_cleanup_failure_hook,
    remove_if_exists,
    safe_remove_dir,
    update_symlink_to_latest,
)


ASN_TEMP_DIR_NAME = ".tmp-ipverse-asn"


def _asn_temp_dir(work_dir: Path) -> Path:
    return work_dir / ASN_TEMP_DIR_NAME


def _asn_output_paths(work_dir: Path, date_tag: str):
    return {
        "asn_mmdb": work_dir / f"ip2asn-nossl-sh-{date_tag}.mmdb",
        "asn_latest_link": work_dir / "ip2asn-latest.mmdb",
    }


cleanup_asn_temp_on_failure = make_temp_cleanup_failure_hook(ASN_TEMP_DIR_NAME, "ASN")


@op(required_resource_keys={"paths"})
def clone_asn_repo(context):
    work_dir = get_work_dir(context)
    temp_dir = _asn_temp_dir(work_dir)
    safe_remove_dir(temp_dir)

    repo_dir = temp_dir / "asn-ip"
    repo_url = "https://github.com/ipverse/asn-ip"

    temp_dir.mkdir(parents=True, exist_ok=True)
    cmd = ["git", "clone", "--depth", "1", "--single-branch", repo_url, str(repo_dir)]
    subprocess.run(cmd, cwd=str(temp_dir), check=True)
    return str(repo_dir)


@op(required_resource_keys={"paths"})
def aggregate_asn(context, asn_repo_dir: str):
    work_dir, bin_dir = get_work_and_bin_dirs(context)
    script = bin_dir / "aggregate_asns.py"
    asn_sqlite = work_dir / "asn.sqlite3"
    as_dir = Path(asn_repo_dir) / "as"

    cmd = [
        "python3",
        str(script),
        "--as-dir",
        str(as_dir),
        "--output",
        str(asn_sqlite),
    ]
    subprocess.run(cmd, cwd=str(work_dir), check=True)
    return str(asn_sqlite)


@op(required_resource_keys={"paths"})
def populate_asn_domains(context, asn_sqlite_path: str):
    work_dir, bin_dir = get_work_and_bin_dirs(context)
    asn_sqlite = Path(asn_sqlite_path)
    if not asn_sqlite.exists():
        raise RuntimeError(f"ASN SQLite output not found before domain populate: {asn_sqlite}")

    script = bin_dir / "populate_asn_domains.py"
    cmd = [
        "python3",
        str(script),
        "--database",
        str(asn_sqlite),
    ]
    subprocess.run(cmd, cwd=str(work_dir), check=True)
    return str(asn_sqlite)


@op(required_resource_keys={"paths"})
def build_asn_mmdb(context, asn_repo_dir: str, _asn_sqlite_path: str, date_tag: str):
    work_dir, bin_dir = get_work_and_bin_dirs(context)
    as_dir = Path(asn_repo_dir) / "as"
    if not as_dir.is_dir():
        raise RuntimeError(f"ASN repo directory not found: {as_dir}")

    build_command = bin_dir / "build_mmdb"
    outputs = _asn_output_paths(work_dir, date_tag)
    asn_mmdb = outputs["asn_mmdb"]

    # Keep shell parity: rm -f old MMDB target before rebuild.
    remove_if_exists(asn_mmdb)

    cmd = [
        str(build_command),
        "--as-dir",
        str(as_dir),
        "--asn-out",
        str(asn_mmdb),
    ]
    subprocess.run(cmd, cwd=str(work_dir), check=True)
    return str(asn_mmdb)


@op(required_resource_keys={"paths"})
def update_asn_latest_symlink(context, asn_mmdb_path: str):
    work_dir = get_work_dir(context)
    link_path = work_dir / "ip2asn-latest.mmdb"
    target_path = Path(asn_mmdb_path)
    update_symlink_to_latest(target_path, link_path)
    return str(link_path)


@op(required_resource_keys={"paths"})
def cleanup_asn_temp_dir(context, _asn_latest_link_path: str):
    work_dir = get_work_dir(context)
    temp_dir = _asn_temp_dir(work_dir)
    safe_remove_dir(temp_dir)
    context.log.info(f"cleaned ASN temp dir: {temp_dir}")


@job(
    executor_def=in_process_executor,
    hooks={cleanup_asn_temp_on_failure},
    tags={GEO_GUARD_PDB_TAG_KEY: GEO_GUARD_TAG_VALUE},
)
def build_asn_data_job():
    date_tag = build_date_tag()
    asn_repo = clone_asn_repo()
    asn_sqlite = aggregate_asn(asn_repo)
    asn_sqlite_with_domains = populate_asn_domains(asn_sqlite)
    upload_file_to_s3.alias("upload_asn_sqlite_to_s3")(asn_sqlite_with_domains, date_tag)
    asn_mmdb = build_asn_mmdb(asn_repo, asn_sqlite_with_domains, date_tag)
    upload_file_to_s3.alias("upload_asn_mmdb_to_s3")(asn_mmdb, date_tag)
    asn_latest = update_asn_latest_symlink(asn_mmdb)
    cleanup_asn_temp_dir(asn_latest)
