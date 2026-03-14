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


def format_sql_for_log(sql: str) -> str:
    return " ".join(str(sql).split())


def log_sql_query(
    *,
    engine: str,
    sql: str,
    params=None,
    batch_count=None,
    log_sink=None,
):
    parts = [
        f"sql_query engine={engine}",
        f'sql="{format_sql_for_log(sql)}"',
    ]
    if params is not None:
        parts.append(f"params={params!r}")
    if batch_count is not None:
        parts.append(f"batch_count={batch_count}")
    message = " ".join(parts)
    if log_sink is not None:
        log_sink(message)
        return
    print(message, file=sys.stderr)


def execute_logged_sql(target, sql: str, params=None, *, engine: str, log_sink=None):
    log_sql_query(
        engine=engine,
        sql=sql,
        params=params,
        log_sink=log_sink,
    )
    if params is None:
        return target.execute(sql)
    return target.execute(sql, params)


def executemany_logged_sql(
    target,
    sql: str,
    batch,
    *,
    engine: str,
    log_sink=None,
):
    log_sql_query(
        engine=engine,
        sql=sql,
        batch_count=len(batch),
        log_sink=log_sink,
    )
    return target.executemany(sql, batch)


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
        execute_logged_sql(
            connection,
            "CREATE TABLE IF NOT EXISTS asn_domain ("
            "asn INTEGER PRIMARY KEY, "
            "domain TEXT"
            ")",
            engine="sqlite",
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


def load_postgres_columns(connection, schema: str, table: str, log_sink=None):
    with connection.cursor() as cursor:
        execute_logged_sql(
            cursor,
            """
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = %s AND table_name = %s
            """,
            (schema, table),
            engine="postgresql",
            log_sink=log_sink,
        )
        return {str(row[0]) for row in cursor.fetchall()}


def log_postgres_setup_step(message: str, log_sink=None):
    if log_sink is not None:
        log_sink(message)
        return
    print(message, file=sys.stderr)


def ensure_postgres_asn_domain_table(connection, log_sink=None):
    required_columns = (
        ("asn", "asn BIGINT"),
        ("domain", "domain TEXT"),
    )

    log_postgres_setup_step(
        "postgres_setup asn_domain create_schema_and_table_start",
        log_sink=log_sink,
    )
    with connection.cursor() as cursor:
        execute_logged_sql(
            cursor,
            f'CREATE SCHEMA IF NOT EXISTS "{PG_ASN_DOMAIN_SCHEMA}"',
            engine="postgresql",
            log_sink=log_sink,
        )
        execute_logged_sql(
            cursor,
            f"""
            CREATE TABLE IF NOT EXISTS {PG_ASN_DOMAIN_QUOTED} (
                asn BIGINT PRIMARY KEY,
                domain TEXT
            )
            """,
            engine="postgresql",
            log_sink=log_sink,
        )
    connection.commit()
    log_postgres_setup_step(
        "postgres_setup asn_domain create_schema_and_table_done",
        log_sink=log_sink,
    )

    log_postgres_setup_step(
        "postgres_setup asn_domain load_columns_before_alter_start",
        log_sink=log_sink,
    )
    existing_columns = load_postgres_columns(
        connection,
        PG_ASN_DOMAIN_SCHEMA,
        PG_ASN_DOMAIN_TABLE,
        log_sink=log_sink,
    )
    log_postgres_setup_step(
        "postgres_setup asn_domain load_columns_before_alter_done "
        f"columns={','.join(sorted(existing_columns))}",
        log_sink=log_sink,
    )
    with connection.cursor() as cursor:
        for column_name, ddl in required_columns:
            if column_name in existing_columns:
                continue
            log_postgres_setup_step(
                f"postgres_setup asn_domain add_column_start column={column_name}",
                log_sink=log_sink,
            )
            execute_logged_sql(
                cursor,
                f"ALTER TABLE {PG_ASN_DOMAIN_QUOTED} ADD COLUMN {ddl}",
                engine="postgresql",
                log_sink=log_sink,
            )
            log_postgres_setup_step(
                f"postgres_setup asn_domain add_column_done column={column_name}",
                log_sink=log_sink,
            )
        log_postgres_setup_step(
            "postgres_setup asn_domain create_unique_index_start "
            "index=idx_asn_domain_pg_asn",
            log_sink=log_sink,
        )
        execute_logged_sql(
            cursor,
            f"""
            CREATE UNIQUE INDEX IF NOT EXISTS "idx_asn_domain_pg_asn"
            ON {PG_ASN_DOMAIN_QUOTED} (asn)
            """,
            engine="postgresql",
            log_sink=log_sink,
        )
        log_postgres_setup_step(
            "postgres_setup asn_domain create_unique_index_done "
            "index=idx_asn_domain_pg_asn",
            log_sink=log_sink,
        )
    connection.commit()
    log_postgres_setup_step(
        "postgres_setup asn_domain alter_and_index_commit_done",
        log_sink=log_sink,
    )

    log_postgres_setup_step(
        "postgres_setup asn_domain load_columns_after_setup_start",
        log_sink=log_sink,
    )
    existing_columns = load_postgres_columns(
        connection,
        PG_ASN_DOMAIN_SCHEMA,
        PG_ASN_DOMAIN_TABLE,
        log_sink=log_sink,
    )
    log_postgres_setup_step(
        "postgres_setup asn_domain load_columns_after_setup_done "
        f"columns={','.join(sorted(existing_columns))}",
        log_sink=log_sink,
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
    row = execute_logged_sql(
        connection,
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='asn_geo_pdb'",
        engine="sqlite",
    ).fetchone()
    return row is not None


def domain_from_asn_geo_pdb(connection, asn: int):
    row = execute_logged_sql(
        connection,
        "SELECT domain FROM asn_geo_pdb "
        "WHERE asn = ? AND domain IS NOT NULL AND TRIM(domain) != ''",
        (asn,),
        engine="sqlite",
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
    cursor = execute_logged_sql(
        connection,
        query,
        params,
        engine="sqlite",
    )
    for row in cursor:
        yield row[0]


def count_pending_asns(connection):
    query = (
        "SELECT COUNT(*) "
        "FROM asn a "
        "LEFT JOIN asn_domain d ON a.asn = d.asn "
        "WHERE d.asn IS NULL OR d.domain IS NULL OR d.domain = ''"
    )
    row = execute_logged_sql(
        connection,
        query,
        engine="sqlite",
    ).fetchone()
    return row[0] if row else 0


def sync_postgres_asn_domain(sqlite_connection, postgres_connection):
    sql = (
        f"INSERT INTO {PG_ASN_DOMAIN_QUOTED} (asn, domain) "
        "VALUES (%s, %s) "
        "ON CONFLICT (asn) DO UPDATE SET domain=excluded.domain"
    )

    synced = 0
    batch = []
    cursor = execute_logged_sql(
        sqlite_connection,
        "SELECT asn, domain FROM asn_domain ORDER BY asn",
        engine="sqlite",
    )
    with postgres_connection.cursor() as pg_cursor:
        for asn, domain in cursor:
            batch.append((int(asn), domain))
            if len(batch) >= 1000:
                executemany_logged_sql(
                    pg_cursor,
                    sql,
                    batch,
                    engine="postgresql",
                )
                synced += len(batch)
                batch.clear()
        if batch:
            executemany_logged_sql(
                pg_cursor,
                sql,
                batch,
                engine="postgresql",
            )
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
        table_check = execute_logged_sql(
            connection,
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='asn'",
            engine="sqlite",
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
                        execute_logged_sql(
                            connection,
                            "INSERT INTO asn_domain (asn, domain) "
                            "VALUES (?, ?) "
                            "ON CONFLICT(asn) DO UPDATE SET domain=excluded.domain",
                            (asn, domain),
                            engine="sqlite",
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
