# nossl.sh

nossl.sh is an open project to build and publish a free, accurate Geo IP database
from open sources and to help people connect with better network transparency.
This repo contains the database build tooling plus a lightweight web service that
shows your connection details and offers fast Geo IP lookups.

The service is always HTTP-only (no TLS, no HTTPS). That makes it reliable for
captive portals and Wi-Fi onboarding flows where HTTPS can fail or be blocked.

## Mission

- Build an open, free, and accurate Geo IP database from publicly available data.
- Make the data easy to use for everyone, including simple curl-friendly APIs.
- Invite the community to improve accuracy with feedback and better sources.

## Our Geo IP database

We publish our own Geo IP databases (MMDB) built from IP allocation data and
carefully curated geofeed inputs. The public landing page and download details
live at:

- https://nossl.sh/free-geo-ip-database

The build pipeline lives in `infra/` and includes the MMDB builder plus scripts
that assemble allocation and geofeed inputs.

## Data sources (open)

We primarily rely on open IP allocation data and geofeed metadata. Key upstream
sources include:

- NRO/RIR delegated stats (AFRINIC, APNIC, ARIN, LACNIC, RIPE NCC)
- Public geofeeds from network operators
- Public ASN name lists and registries

## Contributing and feedback

Accuracy improves with real-world feedback. Please share:

- Data corrections (bad locations, wrong ASN/org, missing prefixes)
- New or better open data sources
- Ideas to improve the database build or the lookup service

Open an issue or a PR with details, or point us to reliable sources we can add.

## Fast and free Geo IP (curl-friendly)

- The lookup page: `/free-geo-ip`
- API lookup: `/api/ip?1.1.1.1`
- Request diagnostics JSON: `/api/request-info`

Examples:

```bash
curl http://nossl.sh/api/ip?8.8.8.8
curl http://nossl.sh/api/request-info
```

The main diagnostics page (`/`) shows your IP, headers, and connection status.

## Quick start

```bash
npm install
npm run dev
```

Then open http://localhost:8080.

To run without live reloading:

```bash
npm start
```

## Configuration

Common environment variables:

- `PORT`, `LISTEN_ADDRESS`
- `GEOIP_DB_PATH` (Geo IP MMDB)
- `ASNIP_DB_PATH` (ASN MMDB)
- `ASN_INFO_DB_PATH` (ASN info SQLite)
- `REDIS_URL` (shared reports and beacons)
- `SQLDB` (honeypot/counters SQLite)
- `MAX_HONEYPOT` (max unique honeypot IP rows, default `1024`)
- `MAX_IP_RECORDS` (max unique IP rows per tracked API endpoint, default `100000`)
- `MAX_API_ACCESS` (legacy alias for `MAX_IP_RECORDS`)
