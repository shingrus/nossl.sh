# AGENTS

## Purpose
This repository hosts `nossl.sh`, an Express + EJS diagnostic page that reports
client IP, headers, and connection details. It also exposes JSON endpoints,
honeypot stats, shared report links (Redis), and optional GeoIP/ASN enrichment.

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
- `/healthz` health check
- `/status/:code` return any HTTP status (optional `?location=`)
- `/honeypot` HTML summary, `/api/honeypot` JSON summary
- `/asNNN` ASN detail HTML (requires ASN info DB)
- `/api/asNNN` ASN detail JSON (requires ASN info DB)
- `/report/:id` shared report (requires Redis)

## Environment variables
- `PORT` (default `8080`) and `LISTEN_ADDRESS` (default `127.0.0.1`)
- `SQLDB` path for counters/honeypot SQLite DB (default `counters.db`)
- `MAX_HONEYPOT` record limit (default `1024`)
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
- `deploy-nossl.sh` production deployment script (systemd + nginx)

## Conventions and cautions
- ES modules only (`import`/`export`), no CommonJS.
- Keep the `componets/` directory name unchanged; other files import it.
- When adjusting routes, update both server handlers and template links.
- Preserve no-cache headers on privacy-sensitive endpoints.
- Avoid editing local data files (`*.mmdb`, `*.sqlite3`, `counters.db`) unless
  the task explicitly requires it.
