# VM init

`init-hatchet-runner-vm.sh` sets up everything the VM needs to run the nossl
Hatchet worker (`infra/hatchet`): packages, the `nossl` user, directories, the
worker binary (built from this checkout), the env file, and the systemd unit.
Hatchet Cloud holds schedules, run history, and the dashboard.

## Requirements

- Ubuntu, x86_64, with outbound IPv4 (GitHub and the Supabase pooler are IPv4-only)
- A checkout of this repo on the VM and a user with `sudo`
- No inbound ports beyond SSH

## Run

```bash
git clone https://github.com/shingrus/nossl.sh
sudo bash nossl.sh/infra/init/init-hatchet-runner-vm.sh
sudoedit /etc/nossl/worker.env
sudo systemctl restart nossl-worker
journalctl -u nossl-worker -f
```

To deploy a new version, `git pull` and re-run the script: it rebuilds and
reinstalls the worker and restarts the service. It never overwrites an existing
`/etc/nossl/worker.env`.

## What it sets up

| Path | Owner | Purpose |
|---|---|---|
| `/opt/nossl/bin/nossl-worker` | root | worker binary, built from `infra/hatchet` |
| `/etc/nossl/worker.env` | root:nossl `0640` | secrets and config (template: `nossl-worker.env.example`) |
| `/var/lib/nossl/` | nossl | worker state: source clones and the last few builds (Postgres is the source of truth) |
| `/etc/systemd/system/nossl-worker.service` | root | runs the worker as `nossl`; starts once `HATCHET_CLIENT_TOKEN` is set |

Packages: `ca-certificates`, `curl`, `git`. The build downloads Go
(`GO_VERSION`, checked against `GO_SHA256`) into a temp directory and deletes it
afterwards, so no toolchain stays on the VM.

More packages and directories get added as each job moves to the worker.

## Overrides

Set as environment variables when running the script, for example
`sudo GO_VERSION=1.27.4 GO_SHA256=<sha> bash init-hatchet-runner-vm.sh`:

- `GO_VERSION`, `GO_SHA256`: Go toolchain for the build (checksums at `https://go.dev/dl/?mode=json`)
- `RUN_AS`, `APP_ROOT`, `DATA_DIR`, `ETC_DIR`, `SERVICE_NAME`

## Secrets

All secrets live in `/etc/nossl/worker.env` on the VM. Hatchet Cloud never
sees them; its secrets feature only applies to Hatchet-managed compute. Hatchet
does store task inputs, outputs, and log lines, so keep secrets and visitor IPs
out of all three.
