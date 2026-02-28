from dagster import op, job, Definitions
import subprocess
from pathlib import Path

@op(config_schema={"work_dir": str})
def geofeed(context):
    work_dir = Path(context.op_config["work_dir"])
    binary = Path("/opt/nossl/bin/geofeed-finder-linux-x64")

    cmd = [
        str(binary),
        "-x",
        "-m",
        "-y", "30000",
        "-f", "/home/shingrus/nossl.sh/infra/geofeeds.txt",
    ]

    subprocess.run(cmd, cwd=str(work_dir), check=True)

@job
def geofeed_job():
    geofeed()

defs = Definitions(jobs=[geofeed_job])