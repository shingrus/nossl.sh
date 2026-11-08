# VM init

`init-hatchet-runner-vm.sh` bootstraps the VM that runs the nossl Hatchet
worker (`infra/hatchet`). Hatchet Cloud holds schedules, run history, and the
dashboard; the worker on this VM does the work and keeps the long-lived caches
on local disk.

## Requirements

- Fresh Ubuntu 24.04, x86_64
- Root SSH access
- Outbound internet; no inbound ports are needed beyond SSH

## Run

From a checkout on your machine:

```bash
scp -r infra/init root@<vm>:/root/init
ssh root@<vm> bash /root/init/init-hatchet-runner-vm.sh
```

Then fill in the secrets and start the worker once its binary is installed:

```bash
sudoedit /etc/nossl/worker.env
systemctl restart nossl-worker
journalctl -u nossl-worker -f
```

The script is idempotent: re-run it to update packages, the repo checkout,
and the systemd unit. It never overwrites an existing `/etc/nossl/worker.env`.

## What it sets up

| Path | Owner | Purpose |
|---|---|---|
| `/opt/nossl/bin/` | root | `nossl-worker` (built from `infra/hatchet`, deployed separately) |
| `/opt/nossl/repo/` | root | shallow checkout of this repo (Python job scripts, `infra/geofeeds.txt`) |
| `/etc/nossl/worker.env` | root:nossl `0640` | secrets and config, loaded by systemd |
| `/var/lib/nossl/` | nossl | persistent state; never wiped between runs |
| `/var/lib/nossl/geofeed-cache/` | nossl | geofeed-finder cache (deleting it risks RIR blocks) |
| `/var/lib/nossl/repos/` | nossl | ipverse clones, updated in place (cache; safe to delete) |
| `/var/lib/nossl/pdbcache/` | nossl | PeeringDB cache |
| `/var/lib/nossl/out/` | nossl | last few builds of the MMDBs and `asn.sqlite3` (Postgres is the source of truth) |

Also:

- Packages: `git`, `mtr-tiny`, `dnsutils`, `sqlite3`, `postgresql-client`, and
  `python3` with `psycopg`/`maxminddb`. The Python bits run the job scripts that
  haven't been ported to the worker yet.
- `cap_net_raw` on `mtr-packet` so the unprivileged worker can run `mtr`.
- A 2G swapfile if the VM has no swap (`SWAP_SIZE=0` skips it).
- `nossl-worker.service`, enabled. It starts only once the binary exists and
  `HATCHET_CLIENT_TOKEN` is set.
- Smoke checks: `mtr` and the Team Cymru DNS lookup. Failures are warnings,
  not errors.
- Not yet: geofeed-finder. It will be built from the `shingrus/geofeed-finder`
  main branch when the geofeed job moves to the worker.

## Overrides

Set as environment variables when running the script, for example
`REPO_REF=my-branch bash init-hatchet-runner-vm.sh`:

- `REPO_REF` (default `main`): branch or tag of this repo to check out
- `SWAP_SIZE` (default `2G`, `0` to skip)
- `RUN_AS`, `APP_ROOT`, `DATA_DIR`, `ETC_DIR`, `SERVICE_NAME`

## Secrets

All secrets live in `/etc/nossl/worker.env` on the VM. Hatchet Cloud never
sees them; its secrets feature only applies to Hatchet-managed compute. Hatchet
does store task inputs, outputs, and log lines, so keep secrets and visitor IPs
out of all three.
