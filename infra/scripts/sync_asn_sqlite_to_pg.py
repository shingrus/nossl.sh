#!/usr/bin/env python3
import argparse
import json
import logging
import sqlite3
import sys
from pathlib import Path

try:
    from infra.scripts.aggregate_asns import (
        ensure_postgres_asn_table,
        get_required_pgsql_dsn,
        open_postgres_connection,
    )
    from infra.scripts.populate_asn_domains import ensure_postgres_asn_domain_table
except ImportError:
    from aggregate_asns import (
        ensure_postgres_asn_table,
        get_required_pgsql_dsn,
        open_postgres_connection,
    )
    from populate_asn_domains import ensure_postgres_asn_domain_table


PG_ASN_QUOTED = '"public"."asn"'
PG_ASN_DOMAIN_QUOTED = '"public"."asn_domain"'
PG_ASN_GEO_PDB_QUOTED = '"public"."asn_geo_pdb"'


def setup_logger(level: str) -> logging.Logger:
    log = logging.getLogger("sync-asn-sqlite-to-pg")
    log.setLevel(level)
    if not log.handlers:
        handler = logging.StreamHandler(sys.stderr)
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
        log.addHandler(handler)
    return log


def sqlite_table_exists(connection, table_name: str) -> bool:
    row = connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
        (table_name,),
    ).fetchone()
    return row is not None


def count_sqlite_rows(connection, table_name: str) -> int:
    row = connection.execute(f"SELECT COUNT(*) FROM {table_name}").fetchone()
    return int(row[0]) if row and row[0] is not None else 0


def sync_asn_table(sqlite_connection, postgres_connection, log: logging.Logger) -> int:
    sql = (
        f"INSERT INTO {PG_ASN_QUOTED} "
        "(asn, handle, organization, organization_slug, country, ip_amount, ipv4_amount, ipv6_amount, json) "
        "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s) "
        "ON CONFLICT (asn) DO UPDATE SET "
        "handle=excluded.handle, "
        "organization=excluded.organization, "
        "organization_slug=excluded.organization_slug, "
        "country=excluded.country, "
        "ip_amount=excluded.ip_amount, "
        "ipv4_amount=excluded.ipv4_amount, "
        "ipv6_amount=excluded.ipv6_amount, "
        "json=excluded.json"
    )

    synced = 0
    batch = []
    cursor = sqlite_connection.execute(
        """
        SELECT asn,
               handle,
               organization,
               organization_slug,
               country,
               CAST(ip_amount AS TEXT) AS ip_amount,
               CAST(ipv4_amount AS TEXT) AS ipv4_amount,
               CAST(ipv6_amount AS TEXT) AS ipv6_amount,
               json
          FROM asn
         ORDER BY asn
        """
    )
    with postgres_connection.cursor() as pg_cursor:
        for row in cursor:
            asn, handle, organization, organization_slug, country, ip_amount, ipv4_amount, ipv6_amount, raw_json = row
            json_text = raw_json if raw_json is not None else "{}"
            if raw_json is not None:
                json.loads(raw_json)
            batch.append(
                (
                    int(asn),
                    handle,
                    organization,
                    organization_slug,
                    country,
                    ip_amount,
                    ipv4_amount,
                    ipv6_amount,
                    json_text,
                )
            )
            if len(batch) >= 1000:
                pg_cursor.executemany(sql, batch)
                synced += len(batch)
                if synced % 10_000 == 0:
                    log.info("public.asn sync progress: %d rows", synced)
                batch.clear()
        if batch:
            pg_cursor.executemany(sql, batch)
            synced += len(batch)
    postgres_connection.commit()
    return synced


def sync_asn_domain_table(sqlite_connection, postgres_connection, log: logging.Logger) -> int:
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
                if synced % 10_000 == 0:
                    log.info("public.asn_domain sync progress: %d rows", synced)
                batch.clear()
        if batch:
            pg_cursor.executemany(sql, batch)
            synced += len(batch)
    postgres_connection.commit()
    return synced


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


def ensure_postgres_asn_geo_pdb_table(postgres_connection) -> None:
    required_columns = (
        ("asn", "asn BIGINT"),
        ("country", "country TEXT"),
        ("city", "city TEXT"),
        ("dominance", "dominance DOUBLE PRECISION"),
        ("domain", "domain TEXT"),
    )

    with postgres_connection.cursor() as cursor:
        cursor.execute('CREATE SCHEMA IF NOT EXISTS "public"')
        cursor.execute(
            f"""
            CREATE TABLE IF NOT EXISTS {PG_ASN_GEO_PDB_QUOTED} (
                asn BIGINT PRIMARY KEY,
                country TEXT,
                city TEXT,
                dominance DOUBLE PRECISION,
                domain TEXT
            )
            """
        )
    postgres_connection.commit()

    existing_columns = load_postgres_columns(postgres_connection, "public", "asn_geo_pdb")
    with postgres_connection.cursor() as cursor:
        for column_name, ddl in required_columns:
            if column_name in existing_columns:
                continue
            cursor.execute(f"ALTER TABLE {PG_ASN_GEO_PDB_QUOTED} ADD COLUMN {ddl}")
        cursor.execute(
            f"""
            CREATE UNIQUE INDEX IF NOT EXISTS "idx_asn_geo_pdb_pg_asn"
            ON {PG_ASN_GEO_PDB_QUOTED} (asn)
            """
        )
    postgres_connection.commit()

    existing_columns = load_postgres_columns(postgres_connection, "public", "asn_geo_pdb")
    missing_columns = [
        column_name
        for column_name, _ in required_columns
        if column_name not in existing_columns
    ]
    if missing_columns:
        raise RuntimeError(
            "PostgreSQL table public.asn_geo_pdb missing columns after setup: "
            + ",".join(missing_columns)
        )


def sync_asn_geo_pdb_table(sqlite_connection, postgres_connection, log: logging.Logger) -> int:
    sql = (
        f"INSERT INTO {PG_ASN_GEO_PDB_QUOTED} (asn, country, city, dominance, domain) "
        "VALUES (%s, %s, %s, %s, %s) "
        "ON CONFLICT (asn) DO UPDATE SET "
        "country=excluded.country, "
        "city=excluded.city, "
        "dominance=excluded.dominance, "
        "domain=excluded.domain"
    )

    synced = 0
    batch = []
    cursor = sqlite_connection.execute(
        "SELECT asn, country, city, dominance, domain FROM asn_geo_pdb ORDER BY asn"
    )
    with postgres_connection.cursor() as pg_cursor:
        for asn, country, city, dominance, domain in cursor:
            batch.append((int(asn), country, city, dominance, domain))
            if len(batch) >= 1000:
                pg_cursor.executemany(sql, batch)
                synced += len(batch)
                if synced % 10_000 == 0:
                    log.info("public.asn_geo_pdb sync progress: %d rows", synced)
                batch.clear()
        if batch:
            pg_cursor.executemany(sql, batch)
            synced += len(batch)
    postgres_connection.commit()
    return synced


def main():
    parser = argparse.ArgumentParser(
        description="One-time sync of ASN SQLite data into PostgreSQL."
    )
    parser.add_argument(
        "--database",
        default="asn.sqlite3",
        help="SQLite database path (default: asn.sqlite3)",
    )
    parser.add_argument(
        "--log-level",
        default="INFO",
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
        help="Log level (default: INFO)",
    )
    args = parser.parse_args()
    log = setup_logger(args.log_level)

    db_path = Path(args.database)
    if not db_path.exists():
        log.error("database not found: %s", db_path)
        return 2

    try:
        log.info("Opening PostgreSQL connection")
        pgsql_dsn = get_required_pgsql_dsn()
        postgres_connection = open_postgres_connection(pgsql_dsn)
        log.info("Ensuring PostgreSQL table public.asn")
        ensure_postgres_asn_table(postgres_connection)
        log.info("Ensuring PostgreSQL table public.asn_domain")
        ensure_postgres_asn_domain_table(postgres_connection)
        log.info("Ensuring PostgreSQL table public.asn_geo_pdb")
        ensure_postgres_asn_geo_pdb_table(postgres_connection)
    except Exception as exc:
        log.error("PostgreSQL setup failed: %s", exc)
        return 2

    log.info("Opening SQLite database: %s", db_path)
    sqlite_connection = sqlite3.connect(db_path)
    try:
        if not sqlite_table_exists(sqlite_connection, "asn"):
            log.error("missing table 'asn' in database")
            return 2

        asn_total = count_sqlite_rows(sqlite_connection, "asn")
        log.info("Starting public.asn sync (%d rows planned)", asn_total)
        asn_rows = sync_asn_table(sqlite_connection, postgres_connection, log)
        log.info("Finished public.asn sync (%d rows)", asn_rows)

        if sqlite_table_exists(sqlite_connection, "asn_domain"):
            asn_domain_total = count_sqlite_rows(sqlite_connection, "asn_domain")
            log.info("Starting public.asn_domain sync (%d rows planned)", asn_domain_total)
            asn_domain_rows = sync_asn_domain_table(sqlite_connection, postgres_connection, log)
            log.info("Finished public.asn_domain sync (%d rows)", asn_domain_rows)
        else:
            log.info("Skipped public.asn_domain sync: SQLite table missing")

        if sqlite_table_exists(sqlite_connection, "asn_geo_pdb"):
            asn_geo_pdb_total = count_sqlite_rows(sqlite_connection, "asn_geo_pdb")
            log.info("Starting public.asn_geo_pdb sync (%d rows planned)", asn_geo_pdb_total)
            asn_geo_pdb_rows = sync_asn_geo_pdb_table(sqlite_connection, postgres_connection, log)
            log.info("Finished public.asn_geo_pdb sync (%d rows)", asn_geo_pdb_rows)
        else:
            log.info("Skipped public.asn_geo_pdb sync: SQLite table missing")
        log.info("Sync completed successfully")
        return 0
    finally:
        sqlite_connection.close()
        postgres_connection.close()
        log.info("Closed SQLite and PostgreSQL connections")


if __name__ == "__main__":
    raise SystemExit(main())
