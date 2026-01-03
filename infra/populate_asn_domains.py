#!/usr/bin/env python3
import argparse
import json
import sqlite3
import sys
import time
import urllib.error
import urllib.request
from email.utils import parseaddr
from pathlib import Path


DEFAULT_USER_AGENT = "asn-ip-domain-loader/1.0"


def normalize_domain(value: str):
    if not value:
        return None
    domain = value.strip().lower().strip(".")
    if not domain:
        return None
    try:
        domain = domain.encode("idna").decode("ascii")
    except Exception:
        return domain
    return domain


def domain_from_email(value: str):
    if not value:
        return None
    value = value.strip()
    if value.lower().startswith("mailto:"):
        value = value[7:]
    address = parseaddr(value)[1] or value
    if "@" not in address:
        return None
    domain = address.split("@", 1)[1]
    return normalize_domain(domain)


def domain_from_vcard(vcard):
    for entry in vcard:
        if not isinstance(entry, list) or len(entry) < 4:
            continue
        if entry[0] != "email":
            continue
        value = entry[3]
        if isinstance(value, list):
            for item in value:
                if not isinstance(item, str):
                    continue
                domain = domain_from_email(item)
                if domain:
                    return domain
        elif isinstance(value, str):
            domain = domain_from_email(value)
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
        headers={"User-Agent": user_agent, "Accept": "application/rdap+json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            data = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, urllib.error.HTTPError, ValueError) as exc:
        print(f"warning: RDAP lookup failed for AS{asn}: {exc}", file=sys.stderr)
        return None
    return extract_domain_from_rdap(data)


def ensure_tables(connection):
    with connection:
        connection.execute(
            "CREATE TABLE IF NOT EXISTS asn_domain ("
            "asn INTEGER PRIMARY KEY, "
            "domain TEXT"
            ")"
        )


def iter_pending_asns(connection, limit):
    query = (
        "SELECT a.asn "
        "FROM asn a "
        "LEFT JOIN asn_domain d ON a.asn = d.asn "
        "WHERE d.asn IS NULL OR d.domain IS NULL OR d.domain = '' "
        "ORDER BY a.asn"
    )
    params = ()
    if limit is not None:
        query = f"{query} LIMIT ?"
        params = (limit,)
    cursor = connection.execute(query, params)
    for row in cursor:
        yield row[0]


def count_pending_asns(connection):
    query = (
        "SELECT COUNT(*) "
        "FROM asn a "
        "LEFT JOIN asn_domain d ON a.asn = d.asn "
        "WHERE d.asn IS NULL OR d.domain IS NULL OR d.domain = ''"
    )
    row = connection.execute(query).fetchone()
    return row[0] if row else 0


def main():
    parser = argparse.ArgumentParser(
        description="Populate asn_domain table with email-derived domains from ARIN RDAP."
    )
    parser.add_argument(
        "--database",
        default="combined.sqlite3",
        help="SQLite database path (default: combined.sqlite3)",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=20.0,
        help="RDAP HTTP timeout in seconds (default: 20)",
    )
    parser.add_argument(
        "--delay",
        type=float,
        default=0.2,
        help="Delay between RDAP requests in seconds (default: 0.2)",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Maximum ASNs to process (default: no limit)",
    )
    parser.add_argument(
        "--user-agent",
        default=DEFAULT_USER_AGENT,
        help=f"User-Agent header (default: {DEFAULT_USER_AGENT})",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Fetch domains but do not write to the database",
    )

    args = parser.parse_args()

    db_path = Path(args.database)
    if not db_path.exists():
        print(f"error: database not found: {db_path}", file=sys.stderr)
        return 2

    connection = sqlite3.connect(db_path)
    try:
        ensure_tables(connection)
        table_check = connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='asn'"
        ).fetchone()
        if not table_check:
            print("error: missing table 'asn' in database", file=sys.stderr)
            return 2

        total = 0
        updated = 0
        missing = 0

        pending_total = count_pending_asns(connection)
        planned_total = pending_total
        if args.limit is not None and planned_total > args.limit:
            planned_total = args.limit

        for asn in iter_pending_asns(connection, args.limit):
            total += 1
            print(f"checking AS{asn} ({total}/{planned_total})")
            domain = rdap_lookup_domain(asn, args.timeout, args.user_agent)
            if domain:
                print(f"found domain for AS{asn}: {domain}")
                if args.dry_run:
                    print(f"AS{asn} -> {domain}")
                else:
                    with connection:
                        connection.execute(
                            "INSERT INTO asn_domain (asn, domain) "
                            "VALUES (?, ?) "
                            "ON CONFLICT(asn) DO UPDATE SET domain=excluded.domain",
                            (asn, domain),
                        )
                updated += 1
            else:
                missing += 1
            if args.delay:
                time.sleep(args.delay)

        print(
            "done: processed "
            f"{total} ASN entries, updated {updated}, missing {missing}"
        )
        return 0
    finally:
        connection.close()


if __name__ == "__main__":
    raise SystemExit(main())
