# Pull Agent (S3 -> local MMDB)

This folder contains a small Python pull agent and systemd units to keep a
local `ip2geo` MMDB updated from S3.

## What it does

- Reads date folders in S3 that match `YYYY-MM-DD`
- Picks the latest date folder
- Builds expected file name from that folder:
  `ip2geo-nossl-sh-YYYYMMDD.mmdb`
- Downloads and validates minimum size
- Atomically replaces the target file

## Files

- `pull_latest_ip2geo_mmdb.py` - pull/install script
- `nossl-ip2geo-pull.service` - systemd oneshot service
- `nossl-ip2geo-pull.timer` - periodic timer (hourly by default)
- `pull-agent.env.example` - environment configuration template

## Install example

```bash
sudo install -d /etc/nossl
sudo cp infra/pull-agent/pull-agent.env.example /etc/nossl/ip2geo-pull.env
sudo cp infra/pull-agent/nossl-ip2geo-pull.service /etc/systemd/system/
sudo cp infra/pull-agent/nossl-ip2geo-pull.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now nossl-ip2geo-pull.timer
```

If your checkout path is not `/opt/nossl.sh`, edit
`/etc/systemd/system/nossl-ip2geo-pull.service` and adjust `WorkingDirectory`
and `ExecStart` script path/flags (`--bucket`, `--region`, `--target`).

## Manual run

```bash
python3 infra/pull-agent/pull_latest_ip2geo_mmdb.py \
  --bucket nossl-sh-dbs \
  --region eu-north-1 \
  --target /opt/nossl/ip2geo-latest.mmdb
```

Environment file should contain only AWS credentials when needed.
