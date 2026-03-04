# Pull Agent (S3 -> local DB artifacts)

This folder contains a small Python pull agent and systemd units to keep a
local `ip2geo`/`ip2asn` MMDB and `asn.sqlite3` updated from S3.

## What it does

- Reads date folders in S3 that match `YYYY-MM-DD`
- Picks the latest date folder
- Builds expected file names from that folder:
  `ip2geo-nossl-sh-YYYYMMDD.mmdb`, `ip2asn-nossl-sh-YYYYMMDD.mmdb`,
  and `asn.sqlite3`
- Downloads and validates minimum size
- Atomically replaces the target file
- Calls `POST /api/reload` after `asn.sqlite3` is replaced (default URL:
  `http://127.0.0.1:8080/api/reload`)

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
and `ExecStart` script path/flags (`--bucket`, `--region`, `--geo-target`,
`--asn-target`, `--asn-sqlite-target`).

## Manual run

```bash
python3 infra/pull-agent/nossl-pull-agent.py \
  --bucket nossl-sh-dbs \
  --region eu-north-1 \
  --geo-target /opt/nossl/ip2geo-latest.mmdb \
  --asn-target /opt/nossl/ip2asn-latest.mmdb \
  --asn-sqlite-target /opt/nossl/asn.sqlite3
```

Dry run (download + validate, no install):

```bash
python3 infra/pull-agent/nossl-pull-agent.py \
  --bucket nossl-sh-dbs \
  --region eu-north-1 \
  --geo-target /opt/nossl/ip2geo-latest.mmdb \
  --asn-target /opt/nossl/ip2asn-latest.mmdb \
  --asn-sqlite-target /opt/nossl/asn.sqlite3 \
  --dry-run
```

Environment file should contain only AWS credentials when needed.
