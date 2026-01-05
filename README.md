# nossl.sh

nossl.sh is a lightweight diagnostic page. It returns a search-engine-friendly HTML
page that reports the client's IP address, request headers, and whether the connection reached the service over HTTP or HTTPS.
The project is packaged for deployment on Google Cloud Run.

## Features

- **SEO-friendly HTML** page with descriptive metadata.
- **Connection status** highlighting whether the request arrived via HTTP or HTTPS.
- **Client IP** detection with support for standard proxy headers.
- **Request header table** for quick debugging.
- **JSON API** at `/api/request-info` for programmatic use.
- **Health endpoint** at `/healthz` for Cloud Run monitoring.
- **Honeypot log** at `/honeypot` (HTML) and `/api/honeypot` (JSON) showing the top IPs probing `.env`, persisted in SQLite.
- **Status helper** at `/status/:code` to return any HTTP status (optional `?location=` for redirects).

## Local development

```bash
npm install
npm run dev
```

Then visit [http://localhost:8080](http://localhost:8080).

To run without live reloading:

```bash
npm start
```

## Configuration

- Override the default SQLite database path by setting the `SQLDB` environment variable before starting the server.
- Control honeypot retention with `MAX_HONEYPOT` (defaults to 1024). When the table exceeds 110% of this value, the oldest rows are pruned.
- Optional GeoIP lookup: download a country GeoIP database (e.g., `ip-to-country.mmdb`), keep it out of version control, and point `GEOIP_DB_PATH` to the file (absolute path or relative to the project root) to enrich requests with country/region/city coordinates.
- Optional ASN lookup: download an ASN database (e.g., `ip-to-asn.mmdb`), keep it out of version control, and point `ASNIP_DB_PATH` to the file (absolute path or relative to the project root) to enrich requests with ASN org data.

## Data sources
- ASN - https://github.com/ipverse/as-ip-blocks
- GEO-ip - https://github.com/iplocate/ip-address-databases/

## Useful links

Official ASN allocations come from RIR delegated stats. AS name lists are best-effort labels, not authoritative owner names.

- NRO delegated stats (combined RIR data): https://ftp.ripe.net/pub/stats/ripencc/nro-stats/latest/nro-delegated-stats
- AFRINIC delegated stats: https://ftp.afrinic.net/pub/stats/afrinic/
- APNIC delegated stats: https://ftp.apnic.net/pub/stats/apnic/
- ARIN delegated stats: https://ftp.arin.net/pub/stats/arin/
- LACNIC delegated stats: https://ftp.lacnic.net/pub/stats/lacnic/
- RIPE NCC delegated stats: https://ftp.ripe.net/pub/stats/ripencc/
- RIPE asnames list: https://ftp.ripe.net/ripe/asnames/asn.txt
- POTAROO autnums list: https://bgp.potaroo.net/cidr/autnums.html
- RIPEstat AS overview API: https://stat.ripe.net/docs/data_api#as-overview
