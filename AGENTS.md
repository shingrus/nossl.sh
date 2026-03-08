# AGENTS

## Purpose
This repository hosts `nossl.sh`, an Express + EJS diagnostic page that reports
client IP, headers, and connection details. It also exposes JSON endpoints,
honeypot stats, shared report links (Redis), a Redis-backed beacon lookup with
client-side 404 retries to wait for DNS/Redis propagation, SQLite-backed IP
records for `/api/request-info` and `/api/beacon`, and optional GeoIP/ASN
enrichment.

## Quick start
- Install deps: `npm install`
- Dev server (nodemon): `npm run dev` (default `http://localhost:8080`)
- Production: `npm start`

## Tests
There is no automated test suite. If you need to validate changes, run the app
and manually verify endpoints relevant to your edit (see "Key routes" below).

## Key routes
- `/` main HTML diagnostics page
- `/api/request-info` JSON diagnostics
- `/free-geo-ip` free GeoIP + ASN lookup page
- `/api/ip` GeoIP + ASN JSON lookup (use `?ip=`)
- `/api/beacon` beacon payload lookup via `<uniq>.r.nossl.sh` host (Redis)
- `/healthz` health check
- `/status/:code` return any HTTP status (optional `?location=`)
- `/honeypot` HTML summary, `/api/honeypot` JSON summary
- `/ss` service status page with request counters and updates
- `/asNNN` ASN detail HTML (requires ASN info DB)
- `/api/asNNN` ASN detail JSON (requires ASN info DB)
- `/report/:id` shared report (requires Redis)

## Environment variables
- `PORT` (default `8080`) and `LISTEN_ADDRESS` (default `127.0.0.1`)
- `SQLDB` path for counters/honeypot/IP-records SQLite DB (default `counters.db`)
- `MAX_HONEYPOT` record limit (default `1024`)
- `MAX_IP_RECORDS` max unique IP rows per tracked endpoint (default `100000`)
- `GEOIP_DB_PATH` path to GeoIP country DB (default `ip-to-country.mmdb`)
- `ASNIP_DB_PATH` path to ASN DB (default `ip-to-asn.mmdb`)
- `ASN_INFO_DB_PATH` path to ASN info SQLite DB (enables ASN detail pages)
- `REDIS_URL` (default `redis://127.0.0.1:6379`)
- `REPORT_TTL_SECONDS` TTL for shared reports (default `86400`)
- `TEST_IP` overrides detected client IP for debugging

## Project layout
- `server.js` Express entry point and route wiring
- `componets/` feature modules (note the folder name is intentionally spelled)
- `templates/` EJS views, `templates/partials/` shared fragments
- `static/` CSS, icons, and robots files
- `infra/dagster/definitions.py` Dagster `Definitions` entrypoint (`defs`)
- `infra/dagster/build_data_job.py` Dagster geofeed and PeeringDB ops/jobs (`geofeed_finder_job`, `pdb_asn_geo_job`) and shared `paths` resource
- `infra/dagster/build_asn_data_job.py` Dagster ASN pipeline job (`build_asn_data_job`)
- `infra/dagster/build_geo_database_job.py` Dagster GEO pipeline job (`build_geo_database_job`)
- `infra/dagster/common_ops.py` shared Dagster ops (for example `build_date_tag`)
- `infra/dagster/utils.py` shared Dagster helpers and utilities (paths access, guarded temp-dir cleanup, symlink update, and failure-hook factories)
- `infra/scripts/` Python data tooling (ASN aggregation, domain population, rDNS pipelines)
- `infra/configs/` config and rule files (`rdns_geo_rules.json`, `*.conf`, geofeed lists)
- `infra/beacon/` Go service that ingests dnstap and stores `beacon:<uniq>` in Redis
- `infra/mmdb-builder/` Go toolchain for building the ASN MMDB from per-ASN `aggregated.json` files
- `deploy-nossl.sh` production deployment script (systemd + nginx)

## Dagster build data jobs
- Definitions entrypoint: `infra/dagster/definitions.py` (package `infra.dagster` also exports `defs`).
- Job modules:
  - `infra/dagster/build_data_job.py` for `geofeed_finder_job` and `pdb_asn_geo_job`
  - `infra/dagster/build_asn_data_job.py` for `build_asn_data_job`
  - `infra/dagster/build_geo_database_job.py` for `build_geo_database_job`
- Jobs:
  - `geofeed_finder_job` runs `geofeed_finder`
  - `pdb_asn_geo_job` runs `pdb_asn_geo`
  - `build_asn_data_job` runs `build_date_tag` -> `clone_asn_repo` -> `aggregate_asn` -> `populate_asn_domains` -> `build_asn_mmdb` -> `update_asn_latest_symlink` -> `cleanup_asn_temp_dir`
  - `build_geo_database_job` runs `build_date_tag` -> `clone_ip_geo_repo` -> `build_geo_mmdb` -> `run_rdns_geo` -> `patch_geo_mmdb_with_rdns` -> `update_geo_latest_symlink` -> `cleanup_geo_temp_dir`
- Resource: `paths` with config keys `work_dir` and `bin_dir`; both directories are created if missing.
- `geofeed_finder` executes `geofeed-finder-linux-x64`, parses `[stats] ... total=<n>` from output, and fails if:
  missing stats line, `geofeed_limit < 0`, or `total < geofeed_limit`.
- `geofeed_limit` is optional op config with default `5000`.
- `enable_pgsql` is optional op config with default `false`; when enabled it appends `--pgsql` to `geofeed-finder`.
- `enable_insecure` is optional op config with default `false`; when enabled it appends `--insecure` to `geofeed-finder`.
- On success, `geofeed_finder` emits output and metadata with `total` and `min_total` for observability.
- `pdb_asn_geo` executes `./bin/pdb_asn_geo.py --api-key <PDB_KEY> --clean --asn-db asn.sqlite3 --limit 500 --dump-geofeed .cache/pdbdump.txt`.
- `pdb_asn_geo` requires environment variable `PDB_KEY`; it fails fast if missing.
- `clone_asn_repo` clones `https://github.com/ipverse/asn-ip` into `<work_dir>/.tmp-ipverse-asn/asn-ip` (URL is hardcoded in the op).
- `clone_ip_geo_repo` clones `https://github.com/ipverse/country-ip-blocks` into `<work_dir>/.tmp-ipverse-geo/country-ip-blocks` (URL is hardcoded in the op).
- `aggregate_asn` executes `python3 <bin_dir>/aggregate_asns.py --as-dir <asn-repo>/as --output <work_dir>/asn.sqlite3`.
- `populate_asn_domains` executes `python3 <bin_dir>/populate_asn_domains.py --database <work_dir>/asn.sqlite3`.
- `build_date_tag` captures a single `YYYYMMDD` tag per run, used for MMDB output filenames.
- `build_asn_mmdb` executes `<bin_dir>/build_mmdb --as-dir <asn-repo>/as --asn-out <work_dir>/ip2asn-nossl-sh-<date>.mmdb`, and removes an existing target file first.
- `build_geo_mmdb` executes `<bin_dir>/build_mmdb --country-dir <country-repo>/country --country-out <work_dir>/ip2geo-nossl-sh-<date>.mmdb --geofeed-dir <work_dir>`, and removes an existing target file first.
- `run_rdns_geo` runs `<bin_dir>/rdns_geo.py` with `--db <ips_db>` when `ips_db` op config is set; PostgreSQL passthrough is intentionally not used.
- `patch_geo_mmdb_with_rdns` runs `<bin_dir>/build_mmdb --patch-mmdb <geo-mmdb> --patch-geofeed <work_dir>/rdns_geo.csv` when rDNS output is present.
- `update_asn_latest_symlink` and `update_geo_latest_symlink` update `ip2asn-latest.mmdb` and `ip2geo-latest.mmdb`.
- `clone_asn_repo` performs a safe cleanup of `<work_dir>/.tmp-ipverse-asn` before cloning; `clone_ip_geo_repo` does the same for `<work_dir>/.tmp-ipverse-geo`.
- `cleanup_asn_temp_dir` and `cleanup_geo_temp_dir` remove temp dirs at the end of successful runs.
- `build_asn_data_job` and `build_geo_database_job` have failure hooks that also remove their temp dirs on failed runs.

## ASN MMDB builder
- Go entry point: `infra/mmdb-builder/build_mmdb.go`
- Inputs: `as/<ASN>/aggregated.json` directories (parsed for ASN metadata and IPv4/IPv6 prefixes)
- Optional country inputs: `<country-dir>/<code>/aggregated.json` directories (parsed for country name/code and IPv4/IPv6 prefixes)
- Output: ASN MMDB file (`-asn-out`, default `nossl-sh-ip-to-asn.mmdb`)
- Optional output: country MMDB file (`-country-out`, default `nossl-sh-ip-to-country.mmdb`)
- Flags: `-as-dir` (default `as`), `-asn-out`, `-country-dir`, `-country-out`, and `-test-mmdb`

## Conventions and cautions
- ES modules only (`import`/`export`), no CommonJS.
- Keep the `componets/` directory name unchanged; other files import it.
- When adjusting routes, update both server handlers and template links.
- Preserve no-cache headers on privacy-sensitive endpoints.
- Beacon resolver lookups retry on 404 and reuse the same `uniq`; keep this in sync with the client script.
- Endpoint IP records are written after responses finish; keep logging non-blocking.
- Service status updates are hardcoded in `templates/service-status.ejs`; keep 10 or fewer items and prune older entries.
- Prefer analyzing and reusing existing functions; extend minimally, and only add new functionality if existing helpers are insufficient.
- Use existing utility/helper functions directly when they already provide needed normalization/validation; avoid adding thin wrapper helpers that only forward to existing checks.
- For rDNS geo matcher rules, prefer generalized delimiter-bounded location token patterns (for example `.lon.`, `-lon-`, `_lon_`) with provider/domain scoping when needed; avoid exact-host/service-specific rules unless no safe generalized rule exists.
- Avoid editing local data files (`*.mmdb`, `*.sqlite3`, `counters.db`) unless
  the task explicitly requires it.
