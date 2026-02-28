from __future__ import annotations

import os
import subprocess
from pathlib import Path

from dagster import op, job, Definitions, get_dagster_logger, Failure

@op(config_schema={"work_dir": str})
def geofeed_finder_op(context) -> None:
    """
    Runs:
      ./bin/geofeed-finder-linux-x64 -x -m -y 30000 -f ~/nossl.sh/infra/geofeeds.txt 2>&1
    with a configurable work_dir (cwd), so bin/ is found and .cache is created there.
    """
    log = get_dagster_logger()

    work_dir = Path(os.path.expanduser(context.op_config["work_dir"])).resolve()


    binary = work_dir /  "bin" / "geofeed-finder-linux-x64"
    geofeeds = Path(os.path.expanduser("~/nossl.sh/infra/geofeeds.txt")).resolve()

    if not binary.exists():
        raise Failure(f"Binary not found: {binary}")
    if not geofeeds.exists():
        raise Failure(f"Geofeeds file not found: {geofeeds}")

    # Ensure cache dir exists; tool will fill it
    (work_dir / ".cache").mkdir(parents=True, exist_ok=True)

    cmd = [
        str(binary),
        "-x",
        "-m",
        "-y", 30000,
        "-f", str(geofeeds),
    ]

    log.info(f"cwd={work_dir}")
    log.info("Running: " + " ".join(cmd))

    success_marker = "All files downloaded. Processing disabled."
    saw_success = False

    p = subprocess.Popen(
        cmd,
        cwd=str(work_dir),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,  # 2>&1
        text=True,
        bufsize=1,
    )

    assert p.stdout is not None
    for line in p.stdout:
        line = line.rstrip("\n")
        log.info(line)
        if success_marker in line:
            saw_success = True

    rc = p.wait()
    if rc != 0:
        raise Failure(f"geofeed-finder exited with code {rc}")

    # Optional: enforce the success marker
    if not saw_success:
        raise Failure(f"geofeed-finder finished but did not print success marker: {success_marker}")

    log.info("geofeed-finder finished successfully.")


@job
def geofeed_job():
    geofeed_finder_op()


defs = Definitions(jobs=[geofeed_job])