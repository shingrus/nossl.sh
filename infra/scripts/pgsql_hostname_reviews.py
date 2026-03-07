#!/usr/bin/env python3
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

try:
    import psycopg
except ImportError:  # pragma: no cover - runtime guard
    psycopg = None

try:
    import psycopg2
except ImportError:  # pragma: no cover - runtime guard
    psycopg2 = None

PG_IDENTIFIER_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


@dataclass(frozen=True)
class PgTableRef:
    schema: str
    table: str
    quoted: str


def parse_pg_table_ref(raw_name: str) -> PgTableRef:
    name = (raw_name or "").strip()
    if not name:
        raise ValueError("PostgreSQL table name is empty")
    parts = name.split(".")
    if len(parts) == 1:
        schema = "public"
        table = parts[0]
    elif len(parts) == 2:
        schema, table = parts
    else:
        raise ValueError(f"Invalid PostgreSQL table name: {raw_name}")
    if not PG_IDENTIFIER_RE.fullmatch(schema):
        raise ValueError(f"Invalid PostgreSQL schema identifier: {schema}")
    if not PG_IDENTIFIER_RE.fullmatch(table):
        raise ValueError(f"Invalid PostgreSQL table identifier: {table}")
    quoted = f'"{schema}"."{table}"'
    return PgTableRef(schema=schema, table=table, quoted=quoted)


def open_postgres_connection(dsn: str) -> Any:
    if psycopg is not None:
        return psycopg.connect(dsn)
    if psycopg2 is not None:
        return psycopg2.connect(dsn)
    raise RuntimeError(
        "PostgreSQL support requires 'psycopg' or 'psycopg2'. "
        "Install one of them before using --pgsql."
    )


def ensure_hostname_reviews_table(conn: Any, table_ref: PgTableRef) -> None:
    with conn.cursor() as cur:
        cur.execute(f'CREATE SCHEMA IF NOT EXISTS "{table_ref.schema}"')
        cur.execute(
            f"""
            CREATE TABLE IF NOT EXISTS {table_ref.quoted} (
                hostname TEXT PRIMARY KEY,
                domain TEXT NOT NULL,
                rule_name TEXT NOT NULL DEFAULT '',
                checked_at TIMESTAMPTZ DEFAULT NULL
            )
            """
        )
    conn.commit()


def ensure_ptr_cache_table(conn: Any, table_ref: PgTableRef) -> None:
    with conn.cursor() as cur:
        cur.execute(f'CREATE SCHEMA IF NOT EXISTS "{table_ref.schema}"')
        cur.execute(
            f"""
            CREATE TABLE IF NOT EXISTS {table_ref.quoted} (
                ip INET PRIMARY KEY,
                ptr TEXT DEFAULT NULL,
                status TEXT NOT NULL,
                source TEXT NOT NULL DEFAULT '',
                checked_at TIMESTAMPTZ NOT NULL,
                expires_at TIMESTAMPTZ NOT NULL
            )
            """
        )
        cur.execute(
            f"""
            CREATE INDEX IF NOT EXISTS "{table_ref.table}_expires_at_idx"
            ON {table_ref.quoted} (expires_at)
            """
        )
    conn.commit()


def validate_hostname_reviews_table(conn: Any, table_ref: PgTableRef) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT column_name, is_nullable, column_default
            FROM information_schema.columns
            WHERE table_schema = %s AND table_name = %s
            """,
            (table_ref.schema, table_ref.table),
        )
        rows = cur.fetchall()

    if not rows:
        raise RuntimeError(
            f"PostgreSQL table {table_ref.schema}.{table_ref.table} not found after creation"
        )

    by_name = {str(name): (str(nullable), default) for name, nullable, default in rows}
    required = ("hostname", "domain", "rule_name", "checked_at")
    missing = [name for name in required if name not in by_name]
    if missing:
        raise RuntimeError(
            f"PostgreSQL table {table_ref.schema}.{table_ref.table} missing columns: "
            + ",".join(missing)
        )

    hostname_nullable = by_name["hostname"][0] == "YES"
    domain_nullable = by_name["domain"][0] == "YES"
    if hostname_nullable or domain_nullable:
        raise RuntimeError(
            "PostgreSQL table requires NOT NULL for hostname and domain columns"
        )

    rule_name_default = by_name["rule_name"][1]
    if rule_name_default is None or "''" not in str(rule_name_default):
        raise RuntimeError("PostgreSQL column rule_name must default to empty string")

    checked_at_default = by_name["checked_at"][1]
    if checked_at_default is not None:
        default_text = str(checked_at_default).strip().lower()
        if default_text and not default_text.startswith("null"):
            raise RuntimeError("PostgreSQL column checked_at default must be NULL")


def validate_ptr_cache_table(conn: Any, table_ref: PgTableRef) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT column_name, is_nullable
            FROM information_schema.columns
            WHERE table_schema = %s AND table_name = %s
            """,
            (table_ref.schema, table_ref.table),
        )
        rows = cur.fetchall()

    if not rows:
        raise RuntimeError(
            f"PostgreSQL table {table_ref.schema}.{table_ref.table} not found after creation"
        )

    by_name = {str(name): str(nullable) for name, nullable in rows}
    required = ("ip", "ptr", "status", "source", "checked_at", "expires_at")
    missing = [name for name in required if name not in by_name]
    if missing:
        raise RuntimeError(
            f"PostgreSQL table {table_ref.schema}.{table_ref.table} missing columns: "
            + ",".join(missing)
        )

    required_not_null = ("ip", "status", "source", "checked_at", "expires_at")
    nullable_required = [name for name in required_not_null if by_name[name] == "YES"]
    if nullable_required:
        raise RuntimeError(
            f"PostgreSQL table {table_ref.schema}.{table_ref.table} requires NOT NULL for columns: "
            + ",".join(nullable_required)
        )
