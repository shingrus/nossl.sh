from dagster import op, job, in_process_executor, Output, Field
from dagster import resource
import os
import re
import subprocess
from pathlib import Path

from infra.dagster.concurrency_tags import (
    GEO_GUARD_GEOFEED_TAG_KEY,
    GEO_GUARD_PDB_TAG_KEY,
    GEO_GUARD_TAG_VALUE,
)
from infra.dagster.utils import get_work_and_bin_dirs


@resource(config_schema={"work_dir": str, "bin_dir": str})
def paths(context):
    work_dir = Path(context.resource_config["work_dir"])
    bin_dir = Path(context.resource_config["bin_dir"])
    work_dir.mkdir(parents=True, exist_ok=True)
    bin_dir.mkdir(parents=True, exist_ok=True)
    return {"work_dir": work_dir, "bin_dir": bin_dir}

@op(
    required_resource_keys={"paths"},
    config_schema={
        "geofeed_limit": Field(
            int,
            default_value=5000,
            is_required=False,
            description="Minimum allowed geofeeds total from geofeed-finder stats.",
        ),
        "enable_pgsql": Field(
            bool,
            default_value=False,
            is_required=False,
            description="Append --pgsql to geofeed-finder to enable PostgreSQL-backed storage.",
        ),
        "enable_insecure": Field(
            bool,
            default_value=False,
            is_required=False,
            description="Append --insecure to geofeed-finder.",
        ),
    },
)
def geofeed_finder(context):
    work_dir, bin_dir = get_work_and_bin_dirs(context)
    work_dir.mkdir(parents=True, exist_ok=True)
    bin_dir.mkdir(parents=False, exist_ok=True)
    binary = bin_dir / "geofeed-finder-linux-x64"

    cmd = [
        str(binary),
        "-x",
        "-m",
        "-y", "30000",
        "-f", "/opt/nossl/repo/infra/geofeeds.txt",
    ]
    if context.op_config["enable_pgsql"]:
        cmd.append("--pgsql")
    if context.op_config["enable_insecure"]:
        cmd.append("--insecure")

    result = subprocess.run(
        cmd,
        cwd=str(work_dir),
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    if result.stdout:
        context.log.info(result.stdout.rstrip())

    # Expect a line like: [stats] geofeeds_unique ... total=5383
    match = re.search(r"\[stats[^\n]*\btotal=(\d+)\b", result.stdout or "")
    if not match:
        raise RuntimeError("geofeed-finder output missing [stats] total=<n> line")

    total = int(match.group(1))
    min_total = context.op_config["geofeed_limit"]
    if min_total < 0:
        raise RuntimeError(f"geofeed_limit must be >= 0, got {min_total}")
    if total < min_total:
        raise RuntimeError(
            f"geofeed total too low: total={total}, required>={min_total}"
        )

    yield Output(
        {"total": total, "min_total": min_total},
        metadata={"total": total, "min_total": min_total},
    )


@op(required_resource_keys={"paths"})
def pdb_asn_geo(context):
    work_dir, bin_dir = get_work_and_bin_dirs(context)
    work_dir.mkdir(parents=True, exist_ok=True)
    bin_dir.mkdir(parents=False, exist_ok=True)

    script = bin_dir / "pdb_asn_geo.py"
    api_key = os.getenv("PDB_KEY")
    if not api_key:
        raise RuntimeError("Missing PDB_KEY environment variable")

    cmd = [
        str(script),
        "--api-key", api_key,
        "--clean",
        "--asn-db", "asn.sqlite3",
        "--limit", "500",
        "--dump-geofeed", ".cache/pdbdump.txt",
    ]

    subprocess.run(cmd, cwd=str(work_dir), check=True)


@job(
    executor_def=in_process_executor,
    tags={GEO_GUARD_GEOFEED_TAG_KEY: GEO_GUARD_TAG_VALUE},
)
def geofeed_finder_job():
    geofeed_finder()


@job(
    executor_def=in_process_executor,
    tags={GEO_GUARD_PDB_TAG_KEY: GEO_GUARD_TAG_VALUE},
)
def pdb_asn_geo_job():
    pdb_asn_geo()
