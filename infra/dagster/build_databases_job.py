from dagster import op, job, in_process_executor, failure_hook
import shutil
import subprocess
from pathlib import Path

from infra.dagster.path_utils import get_work_and_bin_dirs, get_work_dir


def _safe_remove_temp_dir(work_dir: Path):
    temp_dir = work_dir / ".tmp-ipverse"
    temp_dir_str = str(temp_dir).strip()
    if not temp_dir_str or temp_dir_str == "/":
        raise RuntimeError(f"Refusing to remove unsafe directory: {temp_dir_str!r}")
    if temp_dir.exists():
        shutil.rmtree(temp_dir)
    return temp_dir


@failure_hook(required_resource_keys={"paths"})
def cleanup_temp_on_failure(context):
    work_dir = get_work_dir(context)
    temp_dir = _safe_remove_temp_dir(work_dir)
    context.log.info(f"failure hook cleaned temp dir: {temp_dir}")


@op(required_resource_keys={"paths"})
def clone_asn_repo(context):
    work_dir = get_work_dir(context)
    temp_dir = _safe_remove_temp_dir(work_dir)
    repo_dir = temp_dir / "asn-ip"
    repo_url = "https://github.com/ipverse/asn-ip"

    temp_dir.mkdir(parents=True, exist_ok=True)
    cmd = ["git", "clone", "--depth", "1", "--single-branch", repo_url, str(repo_dir)]
    subprocess.run(cmd, cwd=str(temp_dir), check=True)
    return str(repo_dir)


@op(required_resource_keys={"paths"})
def clone_ip_geo_repo(context, asn_repo_dir: str):
    work_dir = get_work_dir(context)
    temp_dir = work_dir / ".tmp-ipverse"
    repo_dir = temp_dir / "country-ip-blocks"
    repo_url = "https://github.com/ipverse/country-ip-blocks"

    temp_dir.mkdir(parents=True, exist_ok=True)
    if repo_dir.exists():
        shutil.rmtree(repo_dir)

    cmd = ["git", "clone", "--depth", "1", repo_url, str(repo_dir)]
    subprocess.run(cmd, cwd=str(temp_dir), check=True)
    return asn_repo_dir


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
def cleanup_temp_dir(context, asn_sqlite_path: str):
    work_dir = get_work_dir(context)
    asn_sqlite = Path(asn_sqlite_path)
    if not asn_sqlite.exists():
        raise RuntimeError(f"ASN SQLite output not found before cleanup: {asn_sqlite}")

    temp_dir = _safe_remove_temp_dir(work_dir)
    context.log.info(f"cleaned temp dir: {temp_dir}")


@job(executor_def=in_process_executor, hooks={cleanup_temp_on_failure})
def build_databases_job():
    asn_repo = clone_asn_repo()
    asn_repo_after_geo = clone_ip_geo_repo(asn_repo)
    asn_sqlite = aggregate_asn(asn_repo_after_geo)
    asn_sqlite_with_domains = populate_asn_domains(asn_sqlite)
    cleanup_temp_dir(asn_sqlite_with_domains)
