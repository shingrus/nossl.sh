# Pull Agent (Cloudflare R2 -> local DB artifacts)

This folder contains a small Python pull agent and systemd units to keep a
local `ip2geo`/`ip2asn` MMDB and `asn.sqlite3` updated from the openipdata
Cloudflare R2 bucket (`openipdata-dbs`). It talks to R2 through its
S3-compatible API with `boto3`.

## What it does

- Reads date folders in the bucket that match `YYYY-MM-DD`
- For each file, picks the latest of the last 14 date folders that contains it,
  so the ASN files update even while no new geo file is published
- Builds expected file names from that folder and `--mmdb-name`
  (default `openipdata`): `ip2geo-openipdata-YYYYMMDD.mmdb`,
  `ip2asn-openipdata-YYYYMMDD.mmdb`, and `asn.sqlite3`
- Skips the file when its ETag matches `<target>.etag`, otherwise downloads
  it and validates its size (minimum size and the object's size)
- Atomically replaces the target file, then writes the ETag to `<target>.etag`
- Calls `POST /api/reload` after `asn.sqlite3` is replaced (default URL:
  `http://127.0.0.1:8080/api/reload`)

## Configuration

Everything comes from one environment variable, `R2`:

```
R2=https://<access-key-id>:<secret-access-key>@<account-id>.r2.cloudflarestorage.com/<bucket>
```

The bucket path is optional and defaults to `openipdata-dbs`; the region is
always `auto`. Use a **read-only** R2 API token scoped to the bucket, and
percent-encode the key or secret if they contain `:`, `@` or `/`.

## Change detection

openipdata publishes twice a day and the evening run overwrites that day's
files, often with the same size, so the agent compares ETags, not sizes. The
ETag of each installed file is kept in `<target>.etag` (for example
`/opt/nossl.sh/asn.sqlite3.etag`). A missing `.etag` file means "download",
so the first run after deploying this version re-downloads every file once;
delete a `.etag` file to force a fresh pull. `--dry-run` never writes `.etag`.

## Files

- `nossl-pull-agent.py` - pull/install script
- `nossl-pull-agent.service` - systemd oneshot service
- `nossl-pull-agent.timer` - periodic timer (every 5 minutes by default)
- `nossl-pull-agent.env.example` - environment configuration template

## Install example

```bash
sudo install -m 600 infra/pull-agent/nossl-pull-agent.env.example /etc/nossl-pull-agent.env
sudo cp infra/pull-agent/nossl-pull-agent.service /etc/systemd/system/
sudo cp infra/pull-agent/nossl-pull-agent.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now nossl-pull-agent.timer
```

Fill in `R2` in `/etc/nossl-pull-agent.env`.

If your checkout path is not `/opt/nossl.sh`, edit
`/etc/systemd/system/nossl-pull-agent.service` and adjust `WorkingDirectory`
and `ExecStart` script path/flags (`--geo-target`, `--asn-target`,
`--asn-sqlite-target`).

## Manual run

```bash
set -a; . /etc/nossl-pull-agent.env; set +a
python3 infra/pull-agent/nossl-pull-agent.py \
  --geo-target /opt/nossl/ip2geo-latest.mmdb \
  --asn-target /opt/nossl/ip2asn-latest.mmdb \
  --asn-sqlite-target /opt/nossl/asn.sqlite3
```

Add `--dry-run` to download and validate without installing.
