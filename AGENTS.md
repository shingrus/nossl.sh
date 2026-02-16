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
- `infra/` data tooling (ASN aggregation, domain population)
- `infra/beacon/` Go service that ingests dnstap and stores `beacon:<uniq>` in Redis
- `infra/mmdb-builder/` Go toolchain for building the ASN MMDB from per-ASN `aggregated.json` files
- `deploy-nossl.sh` production deployment script (systemd + nginx)

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
- Avoid editing local data files (`*.mmdb`, `*.sqlite3`, `counters.db`) unless
  the task explicitly requires it.
