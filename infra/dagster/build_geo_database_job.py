from dagster import op, job, in_process_executor, Field, Noneable
import os
import shutil
import subprocess
from pathlib import Path

from infra.dagster.common_ops import build_date_tag, upload_file_to_s3, upload_file_to_github_release
from infra.dagster.concurrency_tags import (
    GEO_GUARD_GEOFEED_TAG_KEY,
    GEO_GUARD_PDB_TAG_KEY,
    GEO_GUARD_TAG_VALUE,
)
from infra.dagster.utils import (
    get_work_and_bin_dirs,
    get_work_dir,
    make_temp_cleanup_failure_hook,
    remove_if_exists,
    safe_remove_dir,
    update_symlink_to_latest,
)
from infra.scripts.rdns_geo import DEFAULT_RULES_URL, run_rdns_geo_pipeline


GEO_TEMP_DIR_NAME = ".tmp-ipverse-geo"
GATE_FAILED_EXIT_CODE = 3


def _geo_temp_dir(work_dir: Path) -> Path:
    return work_dir / GEO_TEMP_DIR_NAME


def _geo_output_paths(work_dir: Path, date_tag: str):
    return {
        "geo_mmdb": work_dir / f"ip2geo-nossl-sh-{date_tag}.mmdb",
        "geo_latest_link": work_dir / "ip2geo-latest.mmdb",
        "rdns_geofeed_output": work_dir / "rdns_geo.csv",
        "rdns_unmatched_output": work_dir / "unmatched.txt",
        "previous_geo_mmdb": work_dir / "ip2geo-previous.mmdb",
    }


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
def snapshot_previous_geo_mmdb(context):
    """Copy the currently published build aside before anything is rebuilt.

    A second build on the same day reuses the dated file name, so the release
    gate needs its own copy of the previous MMDB to compare against.
    """
    work_dir = get_work_dir(context)
    outputs = _geo_output_paths(work_dir, "unused")
    previous = outputs["previous_geo_mmdb"]
    latest = outputs["geo_latest_link"]
    remove_if_exists(previous)
    if not latest.exists():
        context.log.warning(f"no previous geo mmdb at {latest}; release gate will be skipped")
        return ""
    shutil.copyfile(latest.resolve(), previous)
    context.log.info(f"saved previous geo mmdb {latest.resolve()} -> {previous}")
    return str(previous)


@op(required_resource_keys={"paths"})
def build_geo_mmdb(context, country_repo_dir: str, date_tag: str, _previous_geo_mmdb: str):
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
        "rules_url": Field(
            str,
            is_required=False,
            default_value="",
            description=(
                "rDNS rules JSON URL. Empty uses the rdns_geo_rules.json of the deployed "
                "checkout, so rules change only with a deploy, not with every push to main."
            ),
        ),
        "use_mmdb_hop_city": Field(
            bool,
            is_required=False,
            default_value=False,
            description=(
                "Accept a hop's city from the geo MMDB being patched. Off by default: that "
                "MMDB already holds earlier rDNS/PeeringDB guesses, so errors would feed back."
            ),
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
    work_dir = get_work_dir(context)
    outputs = _geo_output_paths(work_dir, "unused")
    geo_mmdb = Path(geo_mmdb_path)
    unknown_ips_url = (context.op_config.get("unknown_ips_url") or "").strip()
    pgsql = context.op_config.get("pgsql")
    maintenance_token = (os.getenv("MAINTENANCE_TOKEN") or "").strip()

    rdns_geofeed_output = outputs["rdns_geofeed_output"]
    rdns_unmatched_output = outputs["rdns_unmatched_output"]

    if not unknown_ips_url:
        raise RuntimeError("run_rdns_geo config 'unknown_ips_url' is required")
    if not maintenance_token:
        raise RuntimeError("Missing MAINTENANCE_TOKEN environment variable")

    remove_if_exists(rdns_geofeed_output)
    remove_if_exists(rdns_unmatched_output)

    if not geo_mmdb.is_file():
        context.log.warning(f"geo mmdb not found for rdns geo: {geo_mmdb}; skipping")
        return {
            "geo_mmdb_path": str(geo_mmdb),
            "rdns_enabled": True,
            "rdns_geofeed_output": str(rdns_geofeed_output),
        }

    done_metrics = run_rdns_geo_pipeline(
        unknown_ips_url=unknown_ips_url,
        mmdb_path=geo_mmdb,
        output_path=rdns_geofeed_output,
        rules_url=(context.op_config.get("rules_url") or "").strip() or DEFAULT_RULES_URL,
        unmatched_zones_path=rdns_unmatched_output,
        pgsql=pgsql,
        maintenance_token=maintenance_token,
        log_sink=context.log.info,
        use_mmdb_hop_city=bool(context.op_config.get("use_mmdb_hop_city")),
    )
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
                "pgsql_mtr_cache_hits",
                "pgsql_mtr_cache_misses",
                "pgsql_ptr_cache_hits",
                "pgsql_ptr_cache_misses",
                "known_city_percent_begin",
                "known_city_percent_end",
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


@op(
    required_resource_keys={"paths"},
    config_schema={
        "enabled": Field(bool, is_required=False, default_value=True),
        "max_changed_share": Field(
            float,
            is_required=False,
            default_value=0.05,
            description="Max share of previously covered IPv4 space allowed to change country.",
        ),
        "max_coverage_drop": Field(
            float,
            is_required=False,
            default_value=0.02,
            description="Max relative loss of covered IPv4 space.",
        ),
    },
)
def check_geo_mmdb_release_gate(context, geo_mmdb_path: str, previous_geo_mmdb: str):
    """Block publishing when the new build differs too much from the previous one."""
    if not context.op_config["enabled"]:
        context.log.warning("geo release gate disabled; skipping")
        return geo_mmdb_path
    if not previous_geo_mmdb or not Path(previous_geo_mmdb).is_file():
        context.log.warning("no previous geo mmdb; skipping release gate")
        return geo_mmdb_path

    work_dir, bin_dir = get_work_and_bin_dirs(context)
    cmd = [
        str(bin_dir / "build_mmdb"),
        "--compare-old",
        previous_geo_mmdb,
        "--compare-new",
        geo_mmdb_path,
        "--max-changed-share",
        str(context.op_config["max_changed_share"]),
        "--max-coverage-drop",
        str(context.op_config["max_coverage_drop"]),
    ]
    result = subprocess.run(
        cmd,
        cwd=str(work_dir),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    output = (result.stdout or "").rstrip()
    if output:
        context.log.info(output)
    if result.returncode == GATE_FAILED_EXIT_CODE:
        raise RuntimeError(f"geo release gate failed; not publishing {geo_mmdb_path}: {output}")
    if result.returncode != 0:
        raise subprocess.CalledProcessError(result.returncode, cmd, output=output)
    return geo_mmdb_path


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


@job(
    executor_def=in_process_executor,
    hooks={cleanup_geo_temp_on_failure},
    tags={
        GEO_GUARD_GEOFEED_TAG_KEY: GEO_GUARD_TAG_VALUE,
        GEO_GUARD_PDB_TAG_KEY: GEO_GUARD_TAG_VALUE,
    },
)
def build_geo_database_job():
    date_tag = build_date_tag()
    previous_geo_mmdb = snapshot_previous_geo_mmdb()
    country_repo = clone_ip_geo_repo()
    geo_mmdb = build_geo_mmdb(country_repo, date_tag, previous_geo_mmdb)
    rdns_geo_result = run_rdns_geo(geo_mmdb)
    patched_geo_mmdb = patch_geo_mmdb_with_rdns(rdns_geo_result)
    released_geo_mmdb = check_geo_mmdb_release_gate(patched_geo_mmdb, previous_geo_mmdb)
    geo_latest = update_geo_latest_symlink(released_geo_mmdb)
    upload_file_to_s3.alias("upload_geo_mmdb_to_s3")(released_geo_mmdb, date_tag)
    upload_file_to_github_release.alias("upload_geo_mmdb_to_github_release")(released_geo_mmdb, date_tag)
    cleanup_geo_temp_dir(geo_latest)
