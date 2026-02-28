#!/usr/bin/env python3
"""
Analyze unmatched rDNS hostnames with OpenAI and automatically extend rules JSON.

Workflow:
1) Read unchecked hostnames from PostgreSQL hostname review table.
2) Load existing rdns_geo rules.
3) Ask OpenAI for high-confidence city rules (grouped by domain).
4) Validate returned rules locally before accepting.
5) Upsert generated rules into PostgreSQL table.
6) Append accepted rules to rules JSON file.
7) Upsert hostname match status into PostgreSQL table.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from pgsql_hostname_reviews import (
    PgTableRef,
    ensure_hostname_reviews_table,
    open_postgres_connection,
    parse_pg_table_ref,
)
from rdns_geo import (
    Rule,
    load_rule_entries_from_url,
    load_rules,
    match_ptr,
    normalize_ptr_hostname,
)

DEFAULT_MODEL = "gpt-5-mini"
DEFAULT_API_BASE = "https://api.openai.com/v1"
DEFAULT_RULES_URL = (
    Path(__file__).resolve().parents[1] / "configs" / "rdns_geo_rules.json"
).resolve().as_uri()
DEFAULT_MAX_HOSTS_PER_DOMAIN = 60
DEFAULT_MAX_DOMAINS_PER_REQUEST = 1
DEFAULT_MIN_CONFIDENCE = "high"
RULES_SYNC_MODEL = "rules_file_sync"
RULES_SYNC_REASON = "synced_from_rules_file"
LOG_HOST_SAMPLE_LIMIT = 5
CONFIDENCE_RANK = {"low": 0, "medium": 1, "high": 2}
DEFAULT_PGSQL_HOSTNAME_TABLE = "hostname_reviews"
DEFAULT_PGSQL_RULES_TABLE = "generated_rules"
DEFAULT_PGSQL_AUDIT_TABLE = "llm_chunk_audit"


@dataclass(frozen=True)
class HostRecord:
    hostname: str
    domain: str


@dataclass(frozen=True)
class ProposedRule:
    name: str
    pattern: str
    domains: tuple[str, ...]
    country: str
    city: str
    confidence: str
    reason: str
    evidence_hosts: tuple[str, ...]


def log(msg: str) -> None:
    ts = dt.datetime.utcnow().replace(microsecond=0).isoformat() + "Z"
    print(f"{ts} {msg}", file=sys.stderr)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Use OpenAI to derive new rdns_geo rules from unchecked PostgreSQL hostnames.",
    )
    parser.add_argument(
        "--pgsql",
        required=False,
        type=str,
        default="",
        help="PostgreSQL DSN (overrides PGSQL env var)",
    )
    parser.add_argument(
        "--pgsql-hostname-table",
        type=str,
        default=DEFAULT_PGSQL_HOSTNAME_TABLE,
        help=(
            "PostgreSQL table for hostname reviews "
            f"(default: {DEFAULT_PGSQL_HOSTNAME_TABLE})"
        ),
    )
    parser.add_argument(
        "--pgsql-rules-table",
        type=str,
        default=DEFAULT_PGSQL_RULES_TABLE,
        help=f"PostgreSQL table for generated rules (default: {DEFAULT_PGSQL_RULES_TABLE})",
    )
    parser.add_argument(
        "--pgsql-audit-table",
        type=str,
        default=DEFAULT_PGSQL_AUDIT_TABLE,
        help=f"PostgreSQL table for LLM audit logs (default: {DEFAULT_PGSQL_AUDIT_TABLE})",
    )
    parser.add_argument(
        "--rules-url",
        default=DEFAULT_RULES_URL,
        type=str,
        help="Rules JSON URL (file://, http://, https://) like rdns_geo.py",
    )
    parser.add_argument(
        "--dump-rules",
        "--rules-out",
        dest="dump_rules",
        type=Path,
        default=None,
        help=(
            "Dump all rules from DB to this JSON file. "
            "--rules-out is kept as a deprecated alias."
        ),
    )
    parser.add_argument(
        "--model",
        default=DEFAULT_MODEL,
        type=str,
        help=f"OpenAI model (default: {DEFAULT_MODEL})",
    )
    parser.add_argument(
        "--api-base",
        default=DEFAULT_API_BASE,
        type=str,
        help=f"OpenAI API base URL (default: {DEFAULT_API_BASE})",
    )
    parser.add_argument(
        "--max-hosts-per-domain",
        type=int,
        default=DEFAULT_MAX_HOSTS_PER_DOMAIN,
        help=f"Max hostnames to send per domain (default: {DEFAULT_MAX_HOSTS_PER_DOMAIN})",
    )
    parser.add_argument(
        "--max-domains-per-request",
        type=int,
        default=DEFAULT_MAX_DOMAINS_PER_REQUEST,
        help=f"Max domains per LLM request (default: {DEFAULT_MAX_DOMAINS_PER_REQUEST})",
    )
    parser.add_argument(
        "--min-confidence",
        type=str,
        default=DEFAULT_MIN_CONFIDENCE,
        choices=tuple(CONFIDENCE_RANK.keys()),
        help="Minimum accepted confidence from LLM",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Run analysis and DB upserts but do not write rules file",
    )
    return parser.parse_args()


def root_domain(host: str) -> str:
    labels = [part for part in host.split(".") if part]
    if len(labels) <= 2:
        return host
    second_level_like = {"co", "com", "net", "org", "gov", "ac", "edu"}
    cctld_like = {"uk", "au", "nz", "jp", "za", "br", "tr"}
    if len(labels) >= 3 and labels[-1] in cctld_like and labels[-2] in second_level_like:
        return ".".join(labels[-3:])
    return ".".join(labels[-2:])


def ensure_tables(
    conn: Any,
    hostname_table: PgTableRef,
    rules_table: PgTableRef,
    audit_table: PgTableRef,
) -> None:
    ensure_hostname_reviews_table(conn, hostname_table)
    schemas = {rules_table.schema, audit_table.schema}
    with conn.cursor() as cur:
        for schema in sorted(schemas):
            cur.execute(f'CREATE SCHEMA IF NOT EXISTS "{schema}"')
        cur.execute(
            f"""
            CREATE TABLE IF NOT EXISTS {rules_table.quoted} (
                name TEXT PRIMARY KEY,
                pattern TEXT NOT NULL,
                domains_json TEXT NOT NULL,
                country TEXT NOT NULL,
                city TEXT NOT NULL,
                confidence TEXT NOT NULL,
                reason TEXT,
                evidence_hosts_json TEXT NOT NULL,
                source_model TEXT NOT NULL,
                rules_url TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
            """
        )
        cur.execute(
            f"""
            CREATE TABLE IF NOT EXISTS {audit_table.quoted} (
                id BIGSERIAL PRIMARY KEY,
                run_id TEXT NOT NULL,
                created_at TEXT NOT NULL,
                chunk_index INTEGER NOT NULL,
                chunk_total INTEGER NOT NULL,
                model TEXT NOT NULL,
                rules_url TEXT NOT NULL,
                domains_json TEXT NOT NULL,
                hosts_count INTEGER NOT NULL,
                system_prompt TEXT NOT NULL,
                user_prompt TEXT NOT NULL,
                raw_response TEXT,
                parse_ok INTEGER NOT NULL,
                error_text TEXT,
                proposed_rules_count INTEGER NOT NULL,
                accepted_rules_count INTEGER NOT NULL,
                rejected_rules_count INTEGER NOT NULL
            )
            """
        )
        cur.execute(
            f"""
            CREATE INDEX IF NOT EXISTS idx_{audit_table.table}_run
            ON {audit_table.quoted} (run_id, chunk_index)
            """
        )
    conn.commit()


def select_unchecked_host_records(
    conn: Any,
    hostname_table: PgTableRef,
) -> list[HostRecord]:
    with conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT hostname, domain
            FROM {hostname_table.quoted}
            WHERE checked_at IS NULL AND rule_name = ''
            ORDER BY hostname
            """
        )
        rows = cur.fetchall()

    out: list[HostRecord] = []
    for row in rows:
        if not row or len(row) < 2:
            continue
        raw_hostname = row[0]
        raw_domain = row[1]
        hostname = normalize_ptr_hostname(raw_hostname if isinstance(raw_hostname, str) else "")
        if not hostname:
            continue
        domain = (
            str(raw_domain).strip().strip(".").lower()
            if isinstance(raw_domain, str) and raw_domain.strip()
            else root_domain(hostname)
        )
        out.append(HostRecord(hostname=hostname, domain=domain))
    return out


def mark_hosts_checked_with_rules(
    conn: Any,
    hostname_table: PgTableRef,
    hosts: list[HostRecord],
    rules: list[Rule],
    only_if_matched: bool,
) -> tuple[int, int]:
    if not hosts:
        return 0, 0

    now = dt.datetime.utcnow().replace(microsecond=0).isoformat() + "Z"
    matched_count = 0
    unmatched_count = 0

    with conn.cursor() as cur:
        for host in hosts:
            found = match_ptr(host.hostname, rules)
            if found:
                matched_count += 1
                cur.execute(
                    f"""
                    UPDATE {hostname_table.quoted}
                    SET domain=%s, rule_name=%s, checked_at=%s
                    WHERE hostname=%s
                    """,
                    (host.domain, found.name, now, host.hostname),
                )
                continue

            unmatched_count += 1
            if only_if_matched:
                cur.execute(
                    f"""
                    UPDATE {hostname_table.quoted}
                    SET domain=%s, rule_name=''
                    WHERE hostname=%s AND checked_at IS NULL
                    """,
                    (host.domain, host.hostname),
                )
            else:
                cur.execute(
                    f"""
                    UPDATE {hostname_table.quoted}
                    SET domain=%s, rule_name='', checked_at=%s
                    WHERE hostname=%s
                    """,
                    (host.domain, now, host.hostname),
                )

    conn.commit()
    return matched_count, unmatched_count


def summarize_host_reviews(
    conn: Any,
    hostname_table: PgTableRef,
    hosts: list[HostRecord],
) -> tuple[int, int, int]:
    if not hosts:
        return 0, 0, 0

    matched = 0
    unmatched = 0
    unchecked = 0
    hostnames = [host.hostname for host in hosts]
    batch_size = 500

    with conn.cursor() as cur:
        for start in range(0, len(hostnames), batch_size):
            chunk = hostnames[start : start + batch_size]
            placeholders = ",".join("%s" for _ in chunk)
            cur.execute(
                f"""
                SELECT rule_name, checked_at
                FROM {hostname_table.quoted}
                WHERE hostname IN ({placeholders})
                """,
                chunk,
            )
            for rule_name, checked_at in cur.fetchall():
                if checked_at is None:
                    unchecked += 1
                    continue
                if isinstance(rule_name, str) and rule_name.strip():
                    matched += 1
                else:
                    unmatched += 1

    return matched, unmatched, unchecked


def build_runtime_rules(base_rules: list[Rule], extra_rules: list[ProposedRule]) -> list[Rule]:
    runtime_rules: list[Rule] = list(base_rules)
    for rule in extra_rules:
        try:
            pattern = re.compile(rule.pattern, re.IGNORECASE)
        except re.error:
            continue
        runtime_rules.append(
            Rule(
                name=rule.name,
                pattern=pattern,
                domains=rule.domains,
                country=rule.country,
                city=rule.city,
            )
        )
    return runtime_rules


def upsert_generated_rule(
    conn: Any,
    rules_table: PgTableRef,
    rule: ProposedRule,
    model: str,
    rules_url: str,
) -> None:
    now = dt.datetime.utcnow().replace(microsecond=0).isoformat() + "Z"
    with conn.cursor() as cur:
        cur.execute(
            f"""
            INSERT INTO {rules_table.quoted} (
                name, pattern, domains_json, country, city,
                confidence, reason, evidence_hosts_json, source_model,
                rules_url, updated_at, created_at
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT(name) DO UPDATE SET
              pattern=excluded.pattern,
              domains_json=excluded.domains_json,
              country=excluded.country,
              city=excluded.city,
              confidence=excluded.confidence,
              reason=excluded.reason,
              evidence_hosts_json=excluded.evidence_hosts_json,
              source_model=excluded.source_model,
              rules_url=excluded.rules_url,
              updated_at=excluded.updated_at
            """,
            (
                rule.name,
                rule.pattern,
                json.dumps(list(rule.domains), ensure_ascii=True),
                rule.country,
                rule.city,
                rule.confidence,
                rule.reason,
                json.dumps(list(rule.evidence_hosts), ensure_ascii=True),
                model,
                rules_url,
                now,
                now,
            ),
        )


def insert_llm_chunk_audit(
    conn: Any,
    audit_table: PgTableRef,
    run_id: str,
    chunk_index: int,
    chunk_total: int,
    model: str,
    rules_url: str,
    domains: list[str],
    hosts_count: int,
    system_prompt: str,
    user_prompt: str,
    raw_response: Optional[str],
    parse_ok: int,
    error_text: Optional[str],
    proposed_rules_count: int,
    accepted_rules_count: int,
    rejected_rules_count: int,
) -> None:
    now = dt.datetime.utcnow().replace(microsecond=0).isoformat() + "Z"
    with conn.cursor() as cur:
        cur.execute(
            f"""
            INSERT INTO {audit_table.quoted} (
                run_id, created_at, chunk_index, chunk_total, model, rules_url,
                domains_json, hosts_count, system_prompt, user_prompt, raw_response,
                parse_ok, error_text, proposed_rules_count, accepted_rules_count, rejected_rules_count
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                run_id,
                now,
                chunk_index,
                chunk_total,
                model,
                rules_url,
                json.dumps(domains, ensure_ascii=True),
                hosts_count,
                system_prompt,
                user_prompt,
                raw_response,
                parse_ok,
                error_text,
                proposed_rules_count,
                accepted_rules_count,
                rejected_rules_count,
            ),
        )


def sync_rules_file_to_db(
    conn: Any,
    rules_table: PgTableRef,
    rule_entries: list[dict[str, Any]],
    rules_url: str,
) -> tuple[int, int, int, int]:
    with conn.cursor() as cur:
        cur.execute(f"SELECT name FROM {rules_table.quoted}")
        existing_rows = cur.fetchall()
    existing_names = {row[0] for row in existing_rows if isinstance(row[0], str) and row[0].strip()}
    synced = 0
    inserted = 0
    updated = 0
    skipped = 0

    for entry in rule_entries:
        if not isinstance(entry, dict):
            skipped += 1
            continue
        name = str(entry.get("name") or "").strip()
        pattern = str(entry.get("pattern") or "").strip()
        domains = normalize_domains(entry.get("domains"))
        country = str(entry.get("country") or "").strip().upper()
        city = str(entry.get("city") or "").strip()

        if not name or not pattern or len(country) != 2 or not city:
            skipped += 1
            continue
        try:
            re.compile(pattern, re.IGNORECASE)
        except re.error:
            skipped += 1
            continue

        rule = ProposedRule(
            name=name,
            pattern=pattern,
            domains=domains,
            country=country,
            city=city,
            confidence="high",
            reason=RULES_SYNC_REASON,
            evidence_hosts=(),
        )
        upsert_generated_rule(
            conn=conn,
            rules_table=rules_table,
            rule=rule,
            model=RULES_SYNC_MODEL,
            rules_url=rules_url,
        )
        synced += 1
        if name in existing_names:
            updated += 1
        else:
            inserted += 1
            existing_names.add(name)

    conn.commit()
    return synced, inserted, updated, skipped


def openai_request(
    api_key: str,
    api_base: str,
    model: str,
    system_prompt: str,
    user_prompt: str,
) -> str:
    payload = {
        "model": model,
        "input": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
    }
    endpoint = f"{api_base.rstrip('/')}/responses"
    req = Request(
        endpoint,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urlopen(req, timeout=120) as resp:
            body = resp.read().decode("utf-8")
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"OpenAI API HTTP {exc.code}: {detail}") from exc
    except URLError as exc:
        raise RuntimeError(f"OpenAI API request failed: {exc}") from exc

    try:
        data = json.loads(body)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"OpenAI API returned non-JSON response: {body[:500]}") from exc

    if isinstance(data.get("output_text"), str) and data["output_text"].strip():
        return data["output_text"].strip()

    output = data.get("output")
    if isinstance(output, list):
        parts: list[str] = []
        for item in output:
            if not isinstance(item, dict):
                continue
            content = item.get("content")
            if not isinstance(content, list):
                continue
            for c in content:
                if not isinstance(c, dict):
                    continue
                text = c.get("text")
                if isinstance(text, str) and text.strip():
                    parts.append(text)
        if parts:
            return "\n".join(parts).strip()

    raise RuntimeError(f"Could not extract text from OpenAI response: {body[:800]}")


def extract_json_payload(raw_text: str) -> dict[str, Any]:
    text = raw_text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text, count=1)
        text = re.sub(r"\s*```$", "", text, count=1)
    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict):
            return parsed
    except json.JSONDecodeError:
        pass

    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1 or end <= start:
        raise ValueError("LLM response does not contain JSON object")
    sliced = text[start : end + 1]
    parsed = json.loads(sliced)
    if not isinstance(parsed, dict):
        raise ValueError("LLM JSON response is not an object")
    return parsed


def normalize_domains(value: Any) -> tuple[str, ...]:
    if value is None:
        return ()
    if isinstance(value, str):
        v = value.strip().strip(".").lower()
        return (v,) if v else ()
    if isinstance(value, list):
        out: list[str] = []
        for item in value:
            if not isinstance(item, str):
                continue
            v = item.strip().strip(".").lower()
            if v:
                out.append(v)
        return tuple(dict.fromkeys(out))
    return ()


def ensure_rule_name(name: str) -> str:
    value = re.sub(r"[^a-z0-9_]+", "_", name.strip().lower())
    value = re.sub(r"_+", "_", value).strip("_")
    return value


def compile_rule_candidate(
    raw: dict[str, Any],
    min_confidence: str,
    domain_to_hosts: dict[str, list[str]],
    existing_names: set[str],
    existing_signatures: set[tuple[str, tuple[str, ...], str, str]],
) -> tuple[Optional[ProposedRule], str]:
    name = ensure_rule_name(str(raw.get("name") or ""))
    pattern = str(raw.get("pattern") or "").strip()
    domains = normalize_domains(raw.get("domains"))
    country = str(raw.get("country") or "").strip().upper()
    city = str(raw.get("city") or "").strip()
    confidence = str(raw.get("confidence") or "").strip().lower()
    reason = str(raw.get("reason") or "").strip()

    evidence_raw = raw.get("evidence_hosts")
    evidence_hosts: list[str] = []
    if isinstance(evidence_raw, list):
        for item in evidence_raw:
            if isinstance(item, str):
                h = normalize_ptr_hostname(item)
                if h:
                    evidence_hosts.append(h)
    evidence_hosts = list(dict.fromkeys(evidence_hosts))

    if not name or not pattern or len(country) != 2 or not city:
        return None, "missing_required_fields"
    if confidence not in CONFIDENCE_RANK:
        return None, "invalid_confidence"
    if CONFIDENCE_RANK[confidence] < CONFIDENCE_RANK[min_confidence]:
        return None, "below_min_confidence"
    if name in existing_names:
        return None, "duplicate_rule_name"

    signature = (pattern, domains, country, city)
    if signature in existing_signatures:
        return None, "duplicate_rule_signature"

    try:
        regex = re.compile(pattern, re.IGNORECASE)
    except re.error:
        return None, "invalid_regex"

    if not domains:
        return None, "missing_domains"

    matched_count = 0
    searched_hosts: list[str] = []
    for domain in domains:
        hosts = domain_to_hosts.get(domain, [])
        searched_hosts.extend(hosts)
        for host in hosts:
            if host == domain or host.endswith(f".{domain}"):
                if regex.search(host):
                    matched_count += 1
    if matched_count == 0:
        return None, "no_matching_host_evidence"

    if not evidence_hosts:
        evidence_hosts = searched_hosts[:3]

    return (
        ProposedRule(
            name=name,
            pattern=pattern,
            domains=domains,
            country=country,
            city=city,
            confidence=confidence,
            reason=reason,
            evidence_hosts=tuple(evidence_hosts[:10]),
        ),
        "accepted",
    )


def chunk_domains(domains: list[str], chunk_size: int) -> list[list[str]]:
    return [domains[i : i + chunk_size] for i in range(0, len(domains), chunk_size)]


def format_host_sample(hosts: list[str], limit: int = LOG_HOST_SAMPLE_LIMIT) -> str:
    if not hosts:
        return "-"
    preview = hosts[:limit]
    suffix = ",..." if len(hosts) > limit else ""
    return ",".join(preview) + suffix


def build_prompts(
    domain_chunk: list[str],
    existing_entries: list[dict[str, Any]],
    grouped_hosts: dict[str, list[str]],
) -> tuple[str, str]:
    chunk_set = set(domain_chunk)

    filtered_rules: list[dict[str, Any]] = []
    for entry in existing_entries:
        domains = normalize_domains(entry.get("domains"))
        if not domains:
            continue
        if any(d in chunk_set for d in domains):
            filtered_rules.append(
                {
                    "name": str(entry.get("name") or "").strip(),
                    "pattern": str(entry.get("pattern") or "").strip(),
                    "domains": list(domains),
                    "country": str(entry.get("country") or "").strip().upper(),
                    "city": str(entry.get("city") or "").strip(),
                }
            )

    hosts_payload = {domain: grouped_hosts.get(domain, []) for domain in domain_chunk}

    system_prompt = (
        "You are a strict network rDNS geo rule generator. "
        "Only return high-confidence city-level rules derived from hostname tokens. "
        "Use delimiter-bounded tokens (., -, _) and provider/domain scoping. "
        "Do not infer city from state-only or country-only abbreviations. "
        "If uncertain, return no rule."
    )

    user_payload = {
        "task": "Check existing rules and unmatched hostnames; propose only missing, high-confidence city rules.",
        "required_output": {
            "rules": [
                {
                    "name": "snake_case_unique_rule_name",
                    "pattern": "regex",
                    "domains": ["example.com"],
                    "country": "US",
                    "city": "City Name",
                    "confidence": "high",
                    "reason": "short reason",
                    "evidence_hosts": ["host.example.com"],
                }
            ]
        },
        "constraints": [
            "Return JSON object only, no markdown.",
            "Confidence must be one of: high, medium, low.",
            "Prefer patterns like (^|[._-])lon([._-]|$) not raw substring lon.",
            "Do not output rules already covered by existing rules.",
            "Do not output vague or low-confidence guesses.",
        ],
        "existing_rules": filtered_rules,
        "unmatched_hostnames_grouped_by_domain": hosts_payload,
    }

    user_prompt = json.dumps(user_payload, ensure_ascii=True)
    return system_prompt, user_prompt


def dump_rules_from_db(conn: Any, rules_table: PgTableRef, path: Path) -> int:
    entries: list[dict[str, Any]] = []
    with conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT name, pattern, domains_json, country, city
            FROM {rules_table.quoted}
            ORDER BY lower(name), name
            """
        )
        rows = cur.fetchall()
    for name, pattern, domains_json, country, city in rows:
        if not all(isinstance(v, str) and v.strip() for v in (name, pattern, country, city)):
            continue
        try:
            parsed_domains = json.loads(domains_json) if isinstance(domains_json, str) else []
        except json.JSONDecodeError:
            continue
        domains = normalize_domains(parsed_domains)
        entries.append(
            {
                "name": name.strip(),
                "pattern": pattern.strip(),
                "domains": list(domains),
                "country": country.strip().upper(),
                "city": city.strip(),
            }
        )

    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(entries, ensure_ascii=True, indent=2)
    path.write_text(text + "\n", encoding="utf-8")
    return len(entries)


def main() -> int:
    args = parse_args()
    pgsql_dsn = (args.pgsql or os.getenv("PGSQL") or "").strip()
    if not pgsql_dsn:
        log("error: --pgsql or PGSQL env var is required")
        return 2

    if args.max_hosts_per_domain <= 0 or args.max_domains_per_request <= 0:
        log("error: max limits must be positive")
        return 2

    try:
        hostname_table = parse_pg_table_ref(args.pgsql_hostname_table)
        rules_table = parse_pg_table_ref(args.pgsql_rules_table)
        audit_table = parse_pg_table_ref(args.pgsql_audit_table)
    except Exception as exc:
        log(f"error: invalid PostgreSQL table setting: {exc}")
        return 2

    try:
        compiled_rules = load_rules(args.rules_url)
        raw_rule_entries = load_rule_entries_from_url(args.rules_url)
    except Exception as exc:
        log(f"error: failed to load rules: {exc}")
        return 2

    conn = None
    try:
        conn = open_postgres_connection(pgsql_dsn)
        ensure_tables(conn, hostname_table, rules_table, audit_table)

        if args.dump_rules is not None:
            dumped = dump_rules_from_db(conn, rules_table, args.dump_rules)
            log(f"rules_dump_written path={args.dump_rules} total_rules={dumped} mode=dump_only")
            return 0

        synced, inserted, updated, skipped = sync_rules_file_to_db(
            conn=conn,
            rules_table=rules_table,
            rule_entries=raw_rule_entries,
            rules_url=args.rules_url,
        )
        log(
            "rules_sync "
            f"synced={synced} inserted={inserted} updated={updated} skipped={skipped} "
            f"pgsql_table={rules_table.schema}.{rules_table.table}"
        )

        pending_host_records = select_unchecked_host_records(conn, hostname_table)
        if not pending_host_records:
            log("no unchecked hostnames found in PostgreSQL table")
            return 0

        log(f"loaded_unchecked_hostnames={len(pending_host_records)}")
        run_id = dt.datetime.utcnow().strftime("%Y%m%dT%H%M%SZ") + f"-pid{os.getpid()}"
        log(f"run_id={run_id}")

        log(
            f"hostnames_pending_check={len(pending_host_records)} "
            f"hostnames_total_input={len(pending_host_records)}"
        )

        matched_by_existing_rules = 0
        remaining_for_llm = 0
        if pending_host_records:
            matched_by_existing_rules, remaining_for_llm = mark_hosts_checked_with_rules(
                conn=conn,
                hostname_table=hostname_table,
                hosts=pending_host_records,
                rules=compiled_rules,
                only_if_matched=True,
            )
            log(
                "initial_rules_check "
                f"matched_by_rules={matched_by_existing_rules} "
                f"remaining_for_llm={remaining_for_llm} "
                f"pgsql_table={hostname_table.schema}.{hostname_table.table}"
            )
        else:
            log("no_unchecked_hostnames_to_process")

        unmatched_only = [
            hr
            for hr in pending_host_records
            if match_ptr(hr.hostname, compiled_rules) is None
        ]
        accepted_rules: list[ProposedRule] = []
        if not unmatched_only:
            if pending_host_records:
                log("all pending hosts already match existing rules; nothing to generate")
        else:
            api_key = os.getenv("OPENAI_API_KEY", "").strip()
            if not api_key:
                log("error: OPENAI_API_KEY env var is required")
                return 2

            grouped: dict[str, list[str]] = {}
            for hr in unmatched_only:
                grouped.setdefault(hr.domain, []).append(hr.hostname)
            for domain in list(grouped.keys()):
                grouped[domain] = sorted(list(dict.fromkeys(grouped[domain])))[: args.max_hosts_per_domain]
            unmatched_by_hostname = {host.hostname: host for host in unmatched_only}

            domains = sorted(grouped.keys())
            log(f"domains_to_check={len(domains)}")
            for domain in domains:
                hosts_for_domain = grouped.get(domain, [])
                log(
                    f"domain_check_plan domain={domain} hosts={len(hosts_for_domain)} "
                    f"sample={format_host_sample(hosts_for_domain)}"
                )
            domain_chunks = chunk_domains(domains, args.max_domains_per_request)

            existing_names = {rule.name for rule in compiled_rules}
            existing_signatures = {
                (rule.pattern.pattern, rule.domains, rule.country, rule.city)
                for rule in compiled_rules
            }

            chunks_total = len(domain_chunks)
            chunks_ok = 0
            chunks_failed = 0
            rules_proposed_total = 0
            rules_accepted_total = 0
            rules_rejected_total = 0

            for idx, chunk in enumerate(domain_chunks, start=1):
                system_prompt, user_prompt = build_prompts(chunk, raw_rule_entries, grouped)
                chunk_hosts_count = sum(len(grouped.get(d, [])) for d in chunk)
                chunk_host_records: list[HostRecord] = []
                for domain in chunk:
                    for hostname in grouped.get(domain, []):
                        host_record = unmatched_by_hostname.get(hostname)
                        if host_record is not None:
                            chunk_host_records.append(host_record)
                log(f"llm_request_domains index={idx}/{len(domain_chunks)} domains={','.join(chunk)}")
                for domain in chunk:
                    hosts_for_domain = grouped.get(domain, [])
                    log(
                        f"llm_request_domain_hosts index={idx}/{len(domain_chunks)} "
                        f"domain={domain} hosts={len(hosts_for_domain)} "
                        f"sample={format_host_sample(hosts_for_domain)}"
                    )
                log(
                    f"llm_request index={idx}/{len(domain_chunks)} domains={len(chunk)} "
                    f"hosts={chunk_hosts_count}"
                )

                raw_response = None
                try:
                    raw_response = openai_request(
                        api_key=api_key,
                        api_base=args.api_base,
                        model=args.model,
                        system_prompt=system_prompt,
                        user_prompt=user_prompt,
                    )
                    log(
                        f"llm_response_received index={idx}/{len(domain_chunks)} "
                        f"response_chars={len(raw_response)}"
                    )
                    payload = extract_json_payload(raw_response)
                except Exception as exc:
                    log(f"warning: llm request failed for chunk {idx}: {exc}")
                    chunks_failed += 1
                    insert_llm_chunk_audit(
                        conn=conn,
                        audit_table=audit_table,
                        run_id=run_id,
                        chunk_index=idx,
                        chunk_total=chunks_total,
                        model=args.model,
                        rules_url=args.rules_url,
                        domains=chunk,
                        hosts_count=chunk_hosts_count,
                        system_prompt=system_prompt,
                        user_prompt=user_prompt,
                        raw_response=raw_response,
                        parse_ok=0,
                        error_text=str(exc),
                        proposed_rules_count=0,
                        accepted_rules_count=0,
                        rejected_rules_count=0,
                    )
                    conn.commit()
                    continue

                rules_raw = payload.get("rules")
                if not isinstance(rules_raw, list):
                    log(f"warning: llm response missing rules array for chunk {idx}")
                    chunks_failed += 1
                    insert_llm_chunk_audit(
                        conn=conn,
                        audit_table=audit_table,
                        run_id=run_id,
                        chunk_index=idx,
                        chunk_total=chunks_total,
                        model=args.model,
                        rules_url=args.rules_url,
                        domains=chunk,
                        hosts_count=chunk_hosts_count,
                        system_prompt=system_prompt,
                        user_prompt=user_prompt,
                        raw_response=raw_response,
                        parse_ok=0,
                        error_text="missing_rules_array",
                        proposed_rules_count=0,
                        accepted_rules_count=0,
                        rejected_rules_count=0,
                    )
                    conn.commit()
                    continue

                chunks_ok += 1
                proposed_in_chunk = len(rules_raw)
                rules_proposed_total += proposed_in_chunk
                log(
                    f"llm_response_rules index={idx}/{len(domain_chunks)} "
                    f"proposed_rules={proposed_in_chunk}"
                )
                accepted_in_chunk = 0
                rejected_in_chunk = 0
                for candidate in rules_raw:
                    if not isinstance(candidate, dict):
                        rejected_in_chunk += 1
                        rules_rejected_total += 1
                        log(
                            f"rule_rejected index={idx}/{len(domain_chunks)} "
                            "name=- reason=invalid_candidate_type"
                        )
                        continue
                    candidate_name = ensure_rule_name(str(candidate.get("name") or "")) or "-"
                    rule, rejection_reason = compile_rule_candidate(
                        raw=candidate,
                        min_confidence=args.min_confidence,
                        domain_to_hosts=grouped,
                        existing_names=existing_names,
                        existing_signatures=existing_signatures,
                    )
                    if not rule:
                        rejected_in_chunk += 1
                        rules_rejected_total += 1
                        log(
                            f"rule_rejected index={idx}/{len(domain_chunks)} "
                            f"name={candidate_name} reason={rejection_reason}"
                        )
                        continue
                    accepted_rules.append(rule)
                    existing_names.add(rule.name)
                    existing_signatures.add((rule.pattern, rule.domains, rule.country, rule.city))
                    upsert_generated_rule(
                        conn=conn,
                        rules_table=rules_table,
                        rule=rule,
                        model=args.model,
                        rules_url=args.rules_url,
                    )
                    accepted_in_chunk += 1
                    rules_accepted_total += 1
                    log(
                        f"accepted_rule name={rule.name} domains={','.join(rule.domains)} "
                        f"country={rule.country} city={rule.city} confidence={rule.confidence}"
                    )

                runtime_rules = build_runtime_rules(compiled_rules, accepted_rules)
                chunk_matched_after_llm, chunk_unmatched_after_llm = mark_hosts_checked_with_rules(
                    conn=conn,
                    hostname_table=hostname_table,
                    hosts=chunk_host_records,
                    rules=runtime_rules,
                    only_if_matched=False,
                )
                log(
                    f"chunk_hosts_checked index={idx} checked={len(chunk_host_records)} "
                    f"matched={chunk_matched_after_llm} unmatched={chunk_unmatched_after_llm}"
                )

                insert_llm_chunk_audit(
                    conn=conn,
                    audit_table=audit_table,
                    run_id=run_id,
                    chunk_index=idx,
                    chunk_total=chunks_total,
                    model=args.model,
                    rules_url=args.rules_url,
                    domains=chunk,
                    hosts_count=chunk_hosts_count,
                    system_prompt=system_prompt,
                    user_prompt=user_prompt,
                    raw_response=raw_response,
                    parse_ok=1,
                    error_text=None,
                    proposed_rules_count=proposed_in_chunk,
                    accepted_rules_count=accepted_in_chunk,
                    rejected_rules_count=rejected_in_chunk,
                )
                conn.commit()
                log(
                    f"chunk_result index={idx} proposed_rules={proposed_in_chunk} "
                    f"accepted_rules={accepted_in_chunk} rejected_rules={rejected_in_chunk}"
                )

            log(
                "llm_summary "
                f"chunks_total={chunks_total} chunks_ok={chunks_ok} chunks_failed={chunks_failed} "
                f"rules_proposed={rules_proposed_total} rules_accepted={rules_accepted_total} "
                f"rules_rejected={rules_rejected_total}"
            )

            if not accepted_rules:
                log("no valid rules accepted from llm")

        if args.dry_run:
            log(f"dry_run enabled; skipping rules dump accepted_rules={len(accepted_rules)}")
            return 0

        log("rules_dump_skipped reason=not_requested_in_processing_mode")

        if pending_host_records:
            matched_after, unmatched_after, unchecked_after = summarize_host_reviews(
                conn=conn,
                hostname_table=hostname_table,
                hosts=pending_host_records,
            )
            log(
                "final_classification "
                f"matched={matched_after} unmatched={unmatched_after} "
                f"unchecked={unchecked_after} "
                f"newly_matched_via_llm={matched_after - matched_by_existing_rules}"
            )
        else:
            log("final_classification skipped=no_pending_hosts")

    finally:
        if conn is not None:
            conn.close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
