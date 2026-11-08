# nossl-worker

Go worker for the nossl data pipelines. It registers workflows with Hatchet
Cloud (schedules, run history, logs) and runs them on the VM prepared by
`infra/init/init-hatchet-runner-vm.sh`. Configuration comes from
`/etc/nossl/worker.env` (template: `infra/init/nossl-worker.env.example`).

## Workflows

### `build-asn-data` (cron `15 */12 * * *` UTC)

Postgres (Supabase) is the source of truth; the VM only keeps caches.

| Task | Does |
|---|---|
| `sync-source` | clones `ipverse/asn-ip` once into `<data>/repos/asn-ip`, then updates it in place; records the commit and the UTC date tag |
| `ingest` | parses `as/*/aggregated.json` and upserts only rows whose content changed into `public.asn` (compared via `md5` in Postgres) |
| `domains` | fills missing `public.asn_domain` rows: PeeringDB domain from `public.asn_geo_pdb` first, else ARIN RDAP; each result is written immediately |
| `build-mmdb` | builds `ip2asn-nossl-sh-<date>.mmdb` with `mmdb.BuildASN` from `infra/mmdb-builder/mmdb` |
| `export-sqlite` | writes `asn.sqlite3` for the website from Postgres-backed data (`asn`, `asn_domain`, `asn_geo_pdb`) |
| `publish` | uploads both files to R2 `<YYYY-MM-DD>/`, replaces `ip2asn-nossl-sh.mmdb` on the `latest` GitHub release, pings `HC_PING_ASN` |

Every task in a run checks that the asn-ip checkout is still at the synced
commit. The tenant-scoped concurrency limit `asn-db` (max 1 run) keeps runs from
overlapping; the PeeringDB job must declare the same limit when it moves here.

Row formatting matches the old Python scripts byte for byte
(`infra/scripts/aggregate_asns.py`, `populate_asn_domains.py`), including the
`json` column, so existing Supabase rows are recognized as unchanged.

## Commands

```bash
nossl-worker            # serve: connect to Hatchet using HATCHET_CLIENT_TOKEN
nossl-worker run-asn    # run build-asn-data once locally, without Hatchet
nossl-worker run-asn -skip-domains -skip-publish
```

Trigger a manual Hatchet run from the dashboard; input `{"skip_publish": true}`
builds everything but uploads nothing.

## Build and deploy

On the VM, `infra/init/init-hatchet-runner-vm.sh` builds the worker from the
checkout (with a temporary Go toolchain), installs it as
`/opt/nossl/bin/nossl-worker`, and restarts the service. To deploy: `git pull`
and re-run it. A restart interrupts running tasks, which Hatchet retries, so
deploy between runs.

Local build (static binary, pure-Go SQLite driver, no cgo):

```bash
cd infra/hatchet
CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o nossl-worker ./cmd/nossl-worker
```

## Parity check against the Python scripts

```bash
python3 parity/dump_python_asn.py /path/to/asn-ip/as /tmp/python.tsv
PARITY_AS_DIR=/path/to/asn-ip/as PARITY_OUT=/tmp/go.tsv go test ./internal/asn -run TestDumpForParity
cmp /tmp/python.tsv /tmp/go.tsv
```
