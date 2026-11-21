# Pull Agent (openipdata.org MMDBs + ASN detail database)

This folder contains a Python updater and systemd units that keep the local
GeoIP and ASN MMDBs current from openipdata.org's public GitHub Releases. These
two files use the GeoLite2 City and ASN layouts. The website's `asn.sqlite3`
detail database continues to update from the Cloudflare R2 export.

## What it does

- Fetches `openipdata-org-ip2geo.mmdb` and `openipdata-org-ip2asn.mmdb` from
  the latest public GitHub release.
- Keeps fetching `asn.sqlite3` from the latest matching date folder in R2.
- Uses HTTP ETag or Last-Modified headers for the public MMDBs and the R2 ETag
  for SQLite to skip unchanged files.
- Downloads each changed file to a temporary file, validates its minimum and
  advertised size, then atomically replaces the target.
- Calls `POST /api/reload` after replacing the ASN SQLite database (default URL:
  `http://127.0.0.1:8080/api/reload`).
- Supports `--dry-run` to download and validate without installing.

The pull agent needs outbound HTTPS access to GitHub. A read-only R2 token is
still required when `--asn-sqlite-target` is configured.

## Configuration

The R2 URL is supplied through the `R2` environment variable:

```
R2=https://<access-key-id>:<secret-access-key>@<account-id>.r2.cloudflarestorage.com/<bucket>
```

The bucket path is optional and defaults to `openipdata-dbs`. The region is
always `auto`. Use a read-only token scoped to the bucket, and percent-encode
the key or secret if they contain `:`, `@` or `/`.

## Change detection

Each installed file stores its source validator in `<target>.etag`. The MMDB
validator is the release asset's ETag, or Last-Modified header when no ETag is
available. The SQLite validator remains the R2 ETag. A missing sidecar forces
a download; `--dry-run` does not change it.

## Files

- `nossl-pull-agent.py` - pull/install script
- `nossl-pull-agent.service` - systemd oneshot service
- `nossl-pull-agent.timer` - periodic timer (every 5 minutes by default)
- `nossl-pull-agent.env.example` - R2 environment template

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
  --geo-target /opt/nossl.sh/ip2geo-latest.mmdb \
  --asn-target /opt/nossl.sh/ip2asn-latest.mmdb \
  --asn-sqlite-target /opt/nossl.sh/asn.sqlite3
```

Add `--dry-run` to download and validate without installing.
