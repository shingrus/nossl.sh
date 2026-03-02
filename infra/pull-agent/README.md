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

- `nossl-pull-agent.py` - pull/install script
- `nossl-pull-agent.service` - systemd oneshot service
- `nossl-pull-agent.timer` - periodic timer (every 5 minutes by default)
- `nossl-pull-agent.env.example` - environment configuration template

## Install example

```bash
sudo install -d /etc/nossl
sudo cp infra/pull-agent/nossl-pull-agent.env.example /etc/nossl/nossl-pull-agent.env
sudo cp infra/pull-agent/nossl-pull-agent.service /etc/systemd/system/
sudo cp infra/pull-agent/nossl-pull-agent.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now nossl-pull-agent.timer
```

If your checkout path is not `/opt/nossl.sh`, edit
`/etc/systemd/system/nossl-pull-agent.service` and adjust `WorkingDirectory`
and `ExecStart` script path/flags (`--bucket`, `--region`, `--target`).

## Manual run

```bash
python3 infra/pull-agent/nossl-pull-agent.py \
  --bucket nossl-sh-dbs \
  --region eu-north-1 \
  --target /opt/nossl/ip2geo-latest.mmdb
```

Environment file should contain only AWS credentials when needed.
