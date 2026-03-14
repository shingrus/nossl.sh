#!/usr/bin/env python3
import argparse
import json
import os
import sqlite3
import sys
import time
import urllib.error
import urllib.request
from email.utils import parseaddr
from pathlib import Path

try:
    import psycopg
except ImportError:  # pragma: no cover - runtime guard
    psycopg = None

try:
    import psycopg2
except ImportError:  # pragma: no cover - runtime guard
    psycopg2 = None


DEFAULT_USER_AGENT = "asn-ip-domain-loader/1.0"
PG_ASN_DOMAIN_SCHEMA = "public"
PG_ASN_DOMAIN_TABLE = "asn_domain"
PG_ASN_DOMAIN_QUOTED = f'"{PG_ASN_DOMAIN_SCHEMA}"."{PG_ASN_DOMAIN_TABLE}"'


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


def rdap_lookup_domain(
    asn: int, timeout: float, user_agent: str, rate_limit_timeout: float
):
    url = f"https://rdap.arin.net/registry/autnum/{asn}"
    request = urllib.request.Request(
        url,
        headers={"User-Agent": user_agent, "Accept": "application/rdap+json"},
    )
    while True:
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                data = json.loads(response.read().decode("utf-8"))
            domain = extract_domain_from_rdap(data)
            if not domain:
                return " "
            if domain == "gmail.com":
                return " "
            return domain
        except urllib.error.HTTPError as exc:
            if exc.code == 429:
                print(
                    "warning: RDAP rate limit hit for "
                    f"AS{asn}; sleeping {rate_limit_timeout:.1f}s before retry",
                    file=sys.stderr,
                )
                if rate_limit_timeout:
                    time.sleep(rate_limit_timeout)
                continue
            if exc.code in {403, 404}:
                print(
                    f"warning: RDAP returned HTTP {exc.code} for AS{asn}",
                    file=sys.stderr,
                )
                return " "
            print(f"warning: RDAP lookup failed for AS{asn}: {exc}", file=sys.stderr)
            return None
        except (urllib.error.URLError, ValueError) as exc:
            print(f"warning: RDAP lookup failed for AS{asn}: {exc}", file=sys.stderr)
            return None


def ensure_tables(connection):
    with connection:
        connection.execute(
            "CREATE TABLE IF NOT EXISTS asn_domain ("
            "asn INTEGER PRIMARY KEY, "
            "domain TEXT"
            ")"
        )


def get_required_pgsql_dsn():
    dsn = (os.getenv("PGSQL") or "").strip()
    if not dsn:
        raise RuntimeError("Missing PGSQL environment variable")
    return dsn


def open_postgres_connection(dsn: str):
    if psycopg is not None:
        return psycopg.connect(dsn)
    if psycopg2 is not None:
        return psycopg2.connect(dsn)
    raise RuntimeError(
        "PostgreSQL support requires 'psycopg' or 'psycopg2'. "
        "Install one of them before using PGSQL."
    )


def load_postgres_columns(connection, schema: str, table: str):
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = %s AND table_name = %s
            """,
            (schema, table),
        )
        return {str(row[0]) for row in cursor.fetchall()}


def ensure_postgres_asn_domain_table(connection):
    required_columns = (
        ("asn", "asn BIGINT"),
        ("domain", "domain TEXT"),
    )

    with connection.cursor() as cursor:
        cursor.execute(f'CREATE SCHEMA IF NOT EXISTS "{PG_ASN_DOMAIN_SCHEMA}"')
        cursor.execute(
            f"""
            CREATE TABLE IF NOT EXISTS {PG_ASN_DOMAIN_QUOTED} (
                asn BIGINT PRIMARY KEY,
                domain TEXT
            )
            """
        )
    connection.commit()

    existing_columns = load_postgres_columns(
        connection,
        PG_ASN_DOMAIN_SCHEMA,
        PG_ASN_DOMAIN_TABLE,
    )
    with connection.cursor() as cursor:
        for column_name, ddl in required_columns:
            if column_name in existing_columns:
                continue
            cursor.execute(f"ALTER TABLE {PG_ASN_DOMAIN_QUOTED} ADD COLUMN {ddl}")
        cursor.execute(
            f"""
            CREATE UNIQUE INDEX IF NOT EXISTS "idx_asn_domain_pg_asn"
            ON {PG_ASN_DOMAIN_QUOTED} (asn)
            """
        )
    connection.commit()

    existing_columns = load_postgres_columns(
        connection,
        PG_ASN_DOMAIN_SCHEMA,
        PG_ASN_DOMAIN_TABLE,
    )
    missing_columns = [
        column_name
        for column_name, _ in required_columns
        if column_name not in existing_columns
    ]
    if missing_columns:
        raise RuntimeError(
            "PostgreSQL table public.asn_domain missing columns after setup: "
            + ",".join(missing_columns)
        )


def has_asn_geo_pdb_table(connection):
    row = connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='asn_geo_pdb'"
    ).fetchone()
    return row is not None


def domain_from_asn_geo_pdb(connection, asn: int):
    row = connection.execute(
        "SELECT domain FROM asn_geo_pdb "
        "WHERE asn = ? AND domain IS NOT NULL AND TRIM(domain) != ''",
        (asn,),
    ).fetchone()
    if not row:
        return None
    return normalize_domain(str(row[0]))


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


def sync_postgres_asn_domain(sqlite_connection, postgres_connection):
    sql = (
        f"INSERT INTO {PG_ASN_DOMAIN_QUOTED} (asn, domain) "
        "VALUES (%s, %s) "
        "ON CONFLICT (asn) DO UPDATE SET domain=excluded.domain"
    )

    synced = 0
    batch = []
    cursor = sqlite_connection.execute(
        "SELECT asn, domain FROM asn_domain ORDER BY asn"
    )
    with postgres_connection.cursor() as pg_cursor:
        for asn, domain in cursor:
            batch.append((int(asn), domain))
            if len(batch) >= 1000:
                pg_cursor.executemany(sql, batch)
                synced += len(batch)
                batch.clear()
        if batch:
            pg_cursor.executemany(sql, batch)
            synced += len(batch)
    postgres_connection.commit()
    return synced


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
        "--rate-limit-timeout",
        type=float,
        default=15.0,
        help="Sleep time after HTTP 429 before retrying in seconds (default: 15)",
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

    try:
        pgsql_dsn = get_required_pgsql_dsn()
        postgres_connection = open_postgres_connection(pgsql_dsn)
        ensure_postgres_asn_domain_table(postgres_connection)
    except Exception as exc:
        print(f"error: PostgreSQL setup failed: {exc}", file=sys.stderr)
        return 2

    db_path = Path(args.database)
    if not db_path.exists():
        postgres_connection.close()
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

        geo_table_available = has_asn_geo_pdb_table(connection)
        if not geo_table_available:
            print(
                "warning: missing table 'asn_geo_pdb'; skipping PeeringDB domain lookup",
                file=sys.stderr,
            )

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
            domain = None
            if geo_table_available:
                domain = domain_from_asn_geo_pdb(connection, asn)
                if domain:
                    print(f"found PeeringDB domain for AS{asn}: {domain}")
                else:
                    print(f"no PeeringDB domain for AS{asn}, falling back to RDAP")

            if not domain:
                domain = rdap_lookup_domain(
                    asn,
                    args.timeout,
                    args.user_agent,
                    args.rate_limit_timeout,
                )
            if domain:
                if domain == " ":
                    print(f"no domain for AS{asn}, storing placeholder")
                else:
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
        if not args.dry_run:
            synced = sync_postgres_asn_domain(connection, postgres_connection)
            print(f"synced PostgreSQL public.asn_domain ({synced} rows)")
        return 0
    finally:
        connection.close()
        postgres_connection.close()


if __name__ == "__main__":
    raise SystemExit(main())
