#!/usr/bin/env python3
import argparse
import json
import sqlite3
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


def load_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        print(f"warning: failed to read {path}: {exc}", file=sys.stderr)
        return None


def iter_aggregated(as_dir: Path):
    entries = []
    counter = 0
    for entry in as_dir.iterdir():
        counter += 1
        if not entry.is_dir():
            continue
        if not entry.name.isdigit():
            continue
        if counter % 1000 == 0:
                    print(f"Work with: {entry} :: {counter}")

        agg_path = entry / "aggregated.json"
        if not agg_path.is_file():
            print(f"warning: missing {agg_path}", file=sys.stderr)
            continue
        data = load_json(agg_path)
        if not isinstance(data, dict):
            print(f"warning: unexpected JSON in {agg_path}", file=sys.stderr)
            continue
        asn_value = data.get("asn")
        if asn_value is None:
            asn_value = int(entry.name)
        elif str(asn_value) != entry.name:
            print(
                f"warning: ASN mismatch in {agg_path} (dir {entry.name}, json {asn_value})",
                file=sys.stderr,
            )
        entries.append((int(asn_value), data))
    return sorted(entries, key=lambda item: item[0])


def domain_from_url(value: str):
    if not value:
        return None
    if "://" not in value:
        value = f"http://{value}"
    try:
        parsed = urllib.parse.urlparse(value)
    except Exception:
        return None
    host = parsed.hostname
    if not host:
        return None
    host = host.lower()
    try:
        host = host.encode("idna").decode("ascii")
    except Exception:
        return host
    return host


def domain_from_email(value: str):
    if not value or "@" not in value:
        return None
    domain = value.split("@", 1)[1].strip().lower()
    if not domain:
        return None
    try:
        domain = domain.encode("idna").decode("ascii")
    except Exception:
        return domain
    return domain


def domain_from_vcard(vcard):
    for entry in vcard:
        if not isinstance(entry, list) or len(entry) < 4:
            continue
        if entry[0] != "email":
            continue
        domain = domain_from_email(entry[3])
        if domain:
            return domain
    for entry in vcard:
        if not isinstance(entry, list) or len(entry) < 4:
            continue
        if entry[0] != "url":
            continue
        domain = domain_from_url(entry[3])
        if domain:
            return domain
    return None


def extract_domain_from_rdap(data):
    queue = [data]
    while queue:
        current = queue.pop(0)
        if not isinstance(current, dict):
            continue

        vcard = current.get("vcardArray")
        if (
            isinstance(vcard, list)
            and len(vcard) > 1
            and isinstance(vcard[1], list)
        ):
            domain = domain_from_vcard(vcard[1])
            if domain:
                return domain
        entities = current.get("entities")
        if isinstance(entities, list):
            queue.extend(entities)
    return None


def rdap_lookup_domain(asn: int, timeout: float, user_agent: str):
    url = f"https://rdap.arin.net/registry/autnum/{asn}"
    request = urllib.request.Request(
        url,
        headers={"User-Agent": user_agent},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            data = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, urllib.error.HTTPError, ValueError) as exc:
        print(f"warning: RDAP lookup failed for AS{asn}: {exc}", file=sys.stderr)
        return None
    return extract_domain_from_rdap(data)


def add_domains(entries, use_rdap: bool, timeout: float, delay: float, user_agent: str):
    cache = {}
    for asn, data in entries:
        domain = None
        if use_rdap:
            if asn in cache:
                domain = cache[asn]
            else:
                domain = rdap_lookup_domain(asn, timeout, user_agent)
                cache[asn] = domain
                if delay:
                    time.sleep(delay)
        data["domain"] = domain


def write_sqlite(entries, output_path: Path):
    connection = sqlite3.connect(output_path)
    try:
        with connection:
            connection.execute(
                "CREATE TABLE IF NOT EXISTS asn ("
                "asn INTEGER PRIMARY KEY, "
                "json TEXT NOT NULL"
                ")"
            )
            connection.execute(
                "CREATE INDEX IF NOT EXISTS idx_asn_asn ON asn(asn)"
            )
            rows = (
                (asn, json.dumps(data, ensure_ascii=True))
                for asn, data in entries
            )
            connection.executemany(
                "INSERT INTO asn (asn, json) VALUES (?, ?) "
                "ON CONFLICT(asn) DO UPDATE SET json=excluded.json",
                rows,
            )
    finally:
        connection.close()


def main():
    parser = argparse.ArgumentParser(
        description="Combine per-ASN aggregated.json files into a SQLite database."
    )
    parser.add_argument("--as-dir", default="as", help="ASN directory (default: as)")
    parser.add_argument(
        "--output",
        default="combined.sqlite3",
        help="Output SQLite database path",
    )

    args = parser.parse_args()

    as_dir = Path(args.as_dir)
    if not as_dir.is_dir():
        print(f"error: ASN directory not found: {as_dir}", file=sys.stderr)
        return 2

    entries = iter_aggregated(as_dir)
    if not entries:
        print("error: no aggregated.json files found", file=sys.stderr)
        return 1


    output_path = Path(args.output)
    write_sqlite(entries, output_path)

    print(f"wrote {output_path} ({len(entries)} ASN entries)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
