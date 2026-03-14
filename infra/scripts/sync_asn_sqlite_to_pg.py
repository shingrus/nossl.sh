#!/usr/bin/env python3
import argparse
import json
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


def sqlite_table_exists(connection, table_name: str) -> bool:
    row = connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
        (table_name,),
    ).fetchone()
    return row is not None


def sync_asn_table(sqlite_connection, postgres_connection) -> int:
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
                batch.clear()
        if batch:
            pg_cursor.executemany(sql, batch)
            synced += len(batch)
    postgres_connection.commit()
    return synced


def sync_asn_domain_table(sqlite_connection, postgres_connection) -> int:
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


def sync_asn_geo_pdb_table(sqlite_connection, postgres_connection) -> int:
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
    args = parser.parse_args()

    db_path = Path(args.database)
    if not db_path.exists():
        print(f"error: database not found: {db_path}", file=sys.stderr)
        return 2

    try:
        pgsql_dsn = get_required_pgsql_dsn()
        postgres_connection = open_postgres_connection(pgsql_dsn)
        ensure_postgres_asn_table(postgres_connection)
        ensure_postgres_asn_domain_table(postgres_connection)
        ensure_postgres_asn_geo_pdb_table(postgres_connection)
    except Exception as exc:
        print(f"error: PostgreSQL setup failed: {exc}", file=sys.stderr)
        return 2

    sqlite_connection = sqlite3.connect(db_path)
    try:
        if not sqlite_table_exists(sqlite_connection, "asn"):
            print("error: missing table 'asn' in database", file=sys.stderr)
            return 2

        asn_rows = sync_asn_table(sqlite_connection, postgres_connection)
        print(f"synced PostgreSQL public.asn ({asn_rows} rows)")

        if sqlite_table_exists(sqlite_connection, "asn_domain"):
            asn_domain_rows = sync_asn_domain_table(sqlite_connection, postgres_connection)
            print(f"synced PostgreSQL public.asn_domain ({asn_domain_rows} rows)")
        else:
            print("skipped PostgreSQL public.asn_domain sync: SQLite table missing")

        if sqlite_table_exists(sqlite_connection, "asn_geo_pdb"):
            asn_geo_pdb_rows = sync_asn_geo_pdb_table(sqlite_connection, postgres_connection)
            print(f"synced PostgreSQL public.asn_geo_pdb ({asn_geo_pdb_rows} rows)")
        else:
            print("skipped PostgreSQL public.asn_geo_pdb sync: SQLite table missing")
        return 0
    finally:
        sqlite_connection.close()
        postgres_connection.close()


if __name__ == "__main__":
    raise SystemExit(main())
