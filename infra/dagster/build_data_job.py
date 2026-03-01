from dagster import op, job, Definitions, in_process_executor, Output
import os
import re
import subprocess
from pathlib import Path


@op(config_schema={"work_dir": str, "bin_dir": str})
def geofeed_finder(context):
    work_dir = Path(context.op_config["work_dir"])
    work_dir.mkdir(parents=True, exist_ok=True)
    bin_dir = Path(context.op_config["bin_dir"])
    bin_dir.mkdir(parents=False, exist_ok=True)
    binary = bin_dir / "geofeed-finder"
    # binary = Path("/opt/nossl/bin/geofeed-finder-linux-x64")

    cmd = [
        str(binary),
        "-x",
        "-m",
        "-y", "30000",
        "-f", "/opt/nossl/repo/infra/geofeeds.txt",
    ]

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
    min_total = 5000
    if total < min_total:
        raise RuntimeError(
            f"geofeed total too low: total={total}, required>={min_total}"
        )

    yield Output(
        {"total": total, "min_total": min_total},
        metadata={"total": total, "min_total": min_total},
    )


@op(config_schema={"work_dir": str, "bin_dir": str})
def pdb_asn_geo(context, geofeed_state):
    work_dir = Path(context.op_config["work_dir"])
    work_dir.mkdir(parents=True, exist_ok=True)
    bin_dir = Path(context.op_config["bin_dir"])
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
    context.log.info(
        "geofeed validation passed: total=%s threshold=%s",
        geofeed_state["total"],
        geofeed_state["min_total"],
    )


@job(executor_def=in_process_executor)
def geofeed_job():
    pdb_asn_geo(geofeed_state=geofeed_finder())


defs = Definitions(jobs=[geofeed_job])
