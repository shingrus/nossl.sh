from dagster import op, job, in_process_executor, Field, Noneable
import os
import re
import subprocess
from pathlib import Path

from infra.dagster.common_ops import build_date_tag, upload_file_to_s3
from infra.dagster.utils import (
    get_work_and_bin_dirs,
    get_work_dir,
    make_temp_cleanup_failure_hook,
    remove_if_exists,
    safe_remove_dir,
    update_symlink_to_latest,
)


GEO_TEMP_DIR_NAME = ".tmp-ipverse-geo"
RDNS_RULES_URL = "https://raw.githubusercontent.com/shingrus/nossl.sh/refs/heads/main/infra/rdns_geo_rules.json"
RDNS_DONE_PATTERN = re.compile(r"^DONE:\s+(?P<body>.+)$", re.MULTILINE)
RDNS_DONE_KV_PATTERN = re.compile(r"([a-z_]+)=(-?\d+)")


def _geo_temp_dir(work_dir: Path) -> Path:
    return work_dir / GEO_TEMP_DIR_NAME


def _geo_output_paths(work_dir: Path, date_tag: str):
    return {
        "geo_mmdb": work_dir / f"ip2geo-nossl-sh-{date_tag}.mmdb",
        "geo_latest_link": work_dir / "ip2geo-latest.mmdb",
        "rdns_geofeed_output": work_dir / "rdns_geo.csv",
        "rdns_unmatched_output": work_dir / "unmatched.txt",
    }


def _parse_rdns_done_metrics(output_text: str) -> dict[str, int]:
    last_match = None
    for match in RDNS_DONE_PATTERN.finditer(output_text or ""):
        last_match = match
    if last_match is None:
        return {}
    body = last_match.group("body")
    return {key: int(value) for key, value in RDNS_DONE_KV_PATTERN.findall(body)}


cleanup_geo_temp_on_failure = make_temp_cleanup_failure_hook(GEO_TEMP_DIR_NAME, "GEO")


@op(required_resource_keys={"paths"})
def clone_ip_geo_repo(context):
    work_dir = get_work_dir(context)
    temp_dir = _geo_temp_dir(work_dir)
    safe_remove_dir(temp_dir)

    repo_dir = temp_dir / "country-ip-blocks"
    repo_url = "https://github.com/ipverse/country-ip-blocks"

    temp_dir.mkdir(parents=True, exist_ok=True)
    cmd = ["git", "clone", "--depth", "1", repo_url, str(repo_dir)]
    subprocess.run(cmd, cwd=str(temp_dir), check=True)
    return str(repo_dir)


@op(required_resource_keys={"paths"})
def build_geo_mmdb(context, country_repo_dir: str, date_tag: str):
    work_dir, bin_dir = get_work_and_bin_dirs(context)
    country_dir = Path(country_repo_dir) / "country"
    if not country_dir.is_dir():
        raise RuntimeError(f"Country repo directory not found: {country_dir}")

    build_command = bin_dir / "build_mmdb"
    outputs = _geo_output_paths(work_dir, date_tag)
    geo_mmdb = outputs["geo_mmdb"]

    # Keep shell parity: rm -f old MMDB target before rebuild.
    remove_if_exists(geo_mmdb)

    cmd = [
        str(build_command),
        "--country-dir",
        str(country_dir),
        "--country-out",
        str(geo_mmdb),
        "--geofeed-dir",
        str(work_dir),
    ]
    subprocess.run(cmd, cwd=str(work_dir), check=True)
    return str(geo_mmdb)


@op(
    required_resource_keys={"paths"},
    config_schema={
        "unknown_ips_url": Field(
            str,
            is_required=True,
            description="Required URL for rdns_geo.py unknown IP API (returns JSON array of IPs).",
        ),
        "pgsql": Field(
            Noneable(str),
            is_required=False,
            default_value=None,
            description=(
                "Optional PostgreSQL DSN pass-through for rdns_geo.py. "
                "Disabled by default. Set to empty string to use PGSQL env var."
            ),
        ),
    },
)
def run_rdns_geo(context, geo_mmdb_path: str):
    work_dir, bin_dir = get_work_and_bin_dirs(context)
    outputs = _geo_output_paths(work_dir, "unused")
    geo_mmdb = Path(geo_mmdb_path)
    unknown_ips_url = (context.op_config.get("unknown_ips_url") or "").strip()
    pgsql = context.op_config.get("pgsql")
    maintenance_token = (os.getenv("MAINTENANCE_TOKEN") or "").strip()

    rdns_geofeed_output = outputs["rdns_geofeed_output"]
    rdns_unmatched_output = outputs["rdns_unmatched_output"]
    rdns_geo_script = bin_dir / "rdns_geo.py"

    if not unknown_ips_url:
        raise RuntimeError("run_rdns_geo config 'unknown_ips_url' is required")
    if not maintenance_token:
        raise RuntimeError("Missing MAINTENANCE_TOKEN environment variable")

    remove_if_exists(rdns_geofeed_output)
    remove_if_exists(rdns_unmatched_output)

    if not rdns_geo_script.is_file():
        context.log.warning(f"rdns geo script not found: {rdns_geo_script}; skipping")
        return {
            "geo_mmdb_path": str(geo_mmdb),
            "rdns_enabled": True,
            "rdns_geofeed_output": str(rdns_geofeed_output),
        }

    if not geo_mmdb.is_file():
        context.log.warning(f"geo mmdb not found for rdns geo: {geo_mmdb}; skipping")
        return {
            "geo_mmdb_path": str(geo_mmdb),
            "rdns_enabled": True,
            "rdns_geofeed_output": str(rdns_geofeed_output),
        }

    cmd = [
        "python3",
        str(rdns_geo_script),
        "--unknown-ips",
        unknown_ips_url,
        "--mmdb",
        str(geo_mmdb),
        "--rules-url",
        RDNS_RULES_URL,
        "--output",
        str(rdns_geofeed_output),
        "--unmatched-zones",
        str(rdns_unmatched_output),
    ]
    if pgsql is not None:
        cmd.extend(["--pgsql", pgsql])
    result = subprocess.run(
        cmd,
        cwd=str(work_dir),
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    if result.stdout:
        context.log.info(result.stdout.rstrip())
    if result.stderr:
        context.log.info(result.stderr.rstrip())
    if result.returncode != 0:
        raise subprocess.CalledProcessError(
            result.returncode,
            cmd,
            output=result.stdout,
            stderr=result.stderr,
        )

    done_metrics = _parse_rdns_done_metrics(f"{result.stdout}\n{result.stderr}")
    if done_metrics:
        if hasattr(context, "add_output_metadata"):
            context.add_output_metadata(done_metrics)
        summary = " ".join(
            f"{key}={done_metrics[key]}"
            for key in (
                "processed",
                "matched",
                "matched_mmdb",
                "matched_rules",
                "unmatched",
                "cymru_missing",
                "country_conflicts",
            )
            if key in done_metrics
        )
        if summary:
            context.log.info(f"rdns_geo_done {summary}")

    return {
        "geo_mmdb_path": str(geo_mmdb),
        "rdns_enabled": True,
        "rdns_geofeed_output": str(rdns_geofeed_output),
        "rdns_done_metrics": done_metrics,
    }


@op(required_resource_keys={"paths"})
def patch_geo_mmdb_with_rdns(context, rdns_geo_result: dict):
    work_dir, bin_dir = get_work_and_bin_dirs(context)
    geo_mmdb = Path(rdns_geo_result["geo_mmdb_path"])
    rdns_enabled = bool(rdns_geo_result.get("rdns_enabled"))
    rdns_geofeed_output = Path(rdns_geo_result["rdns_geofeed_output"])

    if not rdns_enabled:
        return str(geo_mmdb)

    if not rdns_geofeed_output.is_file() or rdns_geofeed_output.stat().st_size == 0:
        context.log.info("rdns geofeed output is empty; skipping patch")
        return str(geo_mmdb)

    build_command = bin_dir / "build_mmdb"
    cmd = [
        str(build_command),
        "--patch-mmdb",
        str(geo_mmdb),
        "--patch-geofeed",
        str(rdns_geofeed_output),
    ]
    subprocess.run(cmd, cwd=str(work_dir), check=True)
    return str(geo_mmdb)


@op(required_resource_keys={"paths"})
def update_geo_latest_symlink(context, geo_mmdb_path: str):
    work_dir = get_work_dir(context)
    link_path = work_dir / "ip2geo-latest.mmdb"
    target_path = Path(geo_mmdb_path)
    update_symlink_to_latest(target_path, link_path)
    return str(link_path)


@op(required_resource_keys={"paths"})
def cleanup_geo_temp_dir(context, _geo_latest_link_path: str):
    work_dir = get_work_dir(context)
    temp_dir = _geo_temp_dir(work_dir)
    safe_remove_dir(temp_dir)
    context.log.info(f"cleaned GEO temp dir: {temp_dir}")


@job(executor_def=in_process_executor, hooks={cleanup_geo_temp_on_failure})
def build_geo_database_job():
    date_tag = build_date_tag()
    country_repo = clone_ip_geo_repo()
    geo_mmdb = build_geo_mmdb(country_repo, date_tag)
    rdns_geo_result = run_rdns_geo(geo_mmdb)
    patched_geo_mmdb = patch_geo_mmdb_with_rdns(rdns_geo_result)
    geo_latest = update_geo_latest_symlink(patched_geo_mmdb)
    upload_file_to_s3.alias("upload_geo_mmdb_to_s3")(patched_geo_mmdb, date_tag)
    cleanup_geo_temp_dir(geo_latest)
