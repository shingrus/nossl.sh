#!/usr/bin/env python3
"""
Derive geofeed hints for unknown-geo destination IPs from the unknown IP API.

Pipeline:
1) Read destination IPs from the unknown IPs API.
2) Keep only public IPs with unknown geo in MMDB.
3) Run mtr in numeric mode to collect hops.
4) Resolve PTR for the last 25% of hops (closest hop has highest priority).
5) Match PTR names against a regex rule dictionary to infer country/city.
6) Confirm destination ASN/prefix via Team Cymru DNS.
7) Write derived geofeed rows.

## rDNS geo rules
- Keep `rdns_geo_rules.json` as strict JSON (no comments, no trailing commas).
- Prefer delimiter-bounded location tokens (`.`, `-`, `_`) over raw substrings.
- Prefer provider/domain-scoped rules for ambiguous tokens.
- Avoid exact hostname/service rules unless there is no safer alternative.
- Do not map state-only tokens (for example: `ct`, `md`, `ca`, `fl`, `nj`, `nh`) to city values.
- When adding rules, validate JSON parsing after edits.

"""

from __future__ import annotations

import argparse
import csv
import ipaddress
import json
import math
import os
import re
import shutil
import socket
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Optional
from urllib.error import URLError, HTTPError
from urllib.parse import urlencode, urlparse
from urllib.request import Request, url2pathname, urlopen

from pgsql_hostname_reviews import (
    PgTableRef,
    ensure_hostname_reviews_table,
    open_postgres_connection,
    parse_pg_table_ref,
    validate_hostname_reviews_table,
)

try:
    import maxminddb
except ImportError:  # pragma: no cover - runtime guard
    maxminddb = None

HOP_TAIL_RATIO = 0.25
DEFAULT_SCAN_LIMIT = 1000
MTR_CYCLES = 1
MTR_TIMEOUT_SECONDS = 30
DIG_TIMEOUT_SECONDS = 8
DOH_TIMEOUT_SECONDS = 8
CYMRU_MIN_PREFIXLEN_V4 = 16



RULES_URL_TIMEOUT_SECONDS = 10
DEFAULT_RULES_URL = (
    Path(__file__).resolve().parents[1] / "configs" / "rdns_geo_rules.json"
).resolve().as_uri()
DEFAULT_PGSQL_TABLE = "hostname_reviews"
DEFAULT_PGSQL_RULES_TABLE = "generated_rules"
DEFAULT_DOH_URL = "https://cloudflare-dns.com/dns-query"
DIG_ERROR_LOG_LIMIT = 10
DOH_ERROR_LOG_LIMIT = 3
DOH_FAILURE_DISABLE_AFTER = 5


dig_cmd_available = True
dig_error_logged = 0
doh_error_logged = 0
doh_failure_streak = 0
doh_disabled = False


def load_rule_entries_from_url(rules_url: str) -> list[dict[str, Any]]:
    source_url = (rules_url or "").strip() or DEFAULT_RULES_URL
    parsed = urlparse(source_url)

    if parsed.scheme in ("", "file"):
        if parsed.scheme == "file" and parsed.netloc not in ("", "localhost"):
            raise ValueError(f"Unsupported file URL host in rules URL: {source_url}")
        raw_path = url2pathname(parsed.path) if parsed.scheme == "file" else source_url
        rules_path = Path(raw_path).expanduser()
        if not rules_path.exists():
            raise ValueError(f"Rules file not found: {rules_path}")
        content = rules_path.read_text(encoding="utf-8")
    elif parsed.scheme in ("http", "https"):
        try:
            with urlopen(source_url, timeout=RULES_URL_TIMEOUT_SECONDS) as response:
                content = response.read().decode("utf-8")
        except URLError as exc:
            raise ValueError(f"Failed to load rules URL {source_url}: {exc}") from exc
    else:
        raise ValueError(
            f"Unsupported rules URL scheme '{parsed.scheme}' in {source_url}. "
            "Use file://, http://, or https://"
        )

    try:
        payload = json.loads(content)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Invalid JSON from rules URL {source_url}: {exc}") from exc

    if not isinstance(payload, list):
        raise ValueError(f"Rules JSON must be an array: {source_url}")

    return payload


@dataclass(frozen=True)
class Rule:
    name: str
    pattern: re.Pattern[str]
    domains: tuple[str, ...]
    country: str
    city: str


@dataclass
class IpCandidate:
    ip: str


@dataclass
class HopEvidence:
    hop_ip: str
    ptr: str
    priority: int  # 1 == closest hop to destination
    distance: int  # 0 == closest, then -1, -2...


@dataclass
class Hint:
    prefix: str
    country: str
    city: str
    destination_ip: str
    total_hops: int
    cymru_asn: str
    cymru_country: str
    match_source: str
    matched_rule: str
    evidence: HopEvidence


@dataclass(frozen=True)
class UnmatchedHostRecord:
    hostname: str
    domain: str


def eprint(*args: object) -> None:
    print(*args, file=sys.stderr)


def normalize_ip(raw: str) -> Optional[str]:
    value = (raw or "").strip()
    if not value:
        return None
    try:
        return str(ipaddress.ip_address(value))
    except ValueError:
        return None


def normalize_country_code(raw: Optional[str]) -> str:
    value = (raw or "").strip().upper()
    return value if len(value) == 2 else ""


def is_public_ip(ip: str) -> bool:
    try:
        return ipaddress.ip_address(ip).is_global
    except ValueError:
        return False


def compile_rules(source: list[dict[str, Any]], source_name: str) -> list[Rule]:
    rules: list[Rule] = []
    for idx, entry in enumerate(source):
        if not isinstance(entry, dict):
            raise ValueError(f"Rule #{idx + 1} from {source_name} must be an object")
        name = str(entry.get("name") or f"rule_{idx + 1}").strip()
        pattern_text = str(entry.get("pattern") or "").strip()
        domains_raw = entry.get("domains")
        country = str(entry.get("country") or "").strip().upper()
        city = str(entry.get("city") or "").strip()
        if not pattern_text or len(country) != 2 or not city:
            raise ValueError(
                f"Rule #{idx + 1} from {source_name} must include pattern, 2-letter country, and city"
            )
        domains: tuple[str, ...] = ()
        if isinstance(domains_raw, str) and domains_raw.strip():
            domains = (domains_raw.strip().strip(".").lower(),)
        elif isinstance(domains_raw, list):
            normalized_domains: list[str] = []
            for value in domains_raw:
                if not isinstance(value, str):
                    raise ValueError(
                        f"Rule #{idx + 1} from {source_name} has non-string domain in domains"
                    )
                domain = value.strip().strip(".").lower()
                if domain:
                    normalized_domains.append(domain)
            domains = tuple(normalized_domains)
        elif domains_raw is not None:
            raise ValueError(
                f"Rule #{idx + 1} from {source_name} domains must be string or list of strings"
            )
        try:
            pattern = re.compile(pattern_text, re.IGNORECASE)
        except re.error as exc:
            raise ValueError(f"Rule #{idx + 1} from {source_name} invalid regex: {exc}") from exc
        rules.append(
            Rule(
                name=name,
                pattern=pattern,
                domains=domains,
                country=country,
                city=city,
            )
        )

    return rules


def load_rules(rules_url: str = DEFAULT_RULES_URL) -> list[Rule]:
    source = load_rule_entries_from_url(rules_url)
    return compile_rules(source, rules_url)


def normalize_domains_value(value: Any) -> tuple[str, ...]:
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


def postgres_table_has_required_columns(
    conn: Any,
    table_ref: PgTableRef,
    required_columns: set[str],
) -> bool:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = %s AND table_name = %s
            """,
            (table_ref.schema, table_ref.table),
        )
        rows = cur.fetchall()
    available = {str(row[0]) for row in rows if row and isinstance(row[0], str)}
    return required_columns.issubset(available)


def load_rule_entries_from_postgres(
    pgsql_dsn: str,
    table_ref: PgTableRef,
) -> tuple[list[dict[str, Any]], int]:
    conn: Any = None
    try:
        conn = open_postgres_connection(pgsql_dsn)
        required_columns = {"name", "pattern", "domains_json", "country", "city"}
        if not postgres_table_has_required_columns(conn, table_ref, required_columns):
            eprint(
                "pgsql_rules_skipped "
                f"table={table_ref.schema}.{table_ref.table} "
                "reason=missing_required_columns"
            )
            return [], 0
        with conn.cursor() as cur:
            cur.execute(
                f"""
                SELECT name, pattern, domains_json, country, city
                FROM {table_ref.quoted}
                ORDER BY lower(name), name
                """
            )
            rows = cur.fetchall()
    finally:
        if conn is not None:
            conn.close()

    entries: list[dict[str, Any]] = []
    skipped = 0
    for row in rows:
        if not row or len(row) < 5:
            skipped += 1
            continue
        name, pattern, domains_json, country, city = row
        if not all(isinstance(v, str) and v.strip() for v in (name, pattern, country, city)):
            skipped += 1
            continue
        try:
            parsed_domains = json.loads(domains_json) if isinstance(domains_json, str) else []
        except json.JSONDecodeError:
            skipped += 1
            continue
        domains = normalize_domains_value(parsed_domains)
        if not domains:
            skipped += 1
            continue
        entries.append(
            {
                "name": name.strip(),
                "pattern": pattern.strip(),
                "domains": list(domains),
                "country": country.strip().upper(),
                "city": city.strip(),
            }
        )
    return entries, skipped


def merge_rule_entries(
    base_entries: list[dict[str, Any]],
    override_entries: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], int, int]:
    merged = list(base_entries)
    index_by_name: dict[str, int] = {}
    for idx, entry in enumerate(merged):
        if not isinstance(entry, dict):
            continue
        name = str(entry.get("name") or "").strip()
        if name and name not in index_by_name:
            index_by_name[name] = idx

    replaced = 0
    appended = 0
    for entry in override_entries:
        if not isinstance(entry, dict):
            continue
        name = str(entry.get("name") or "").strip()
        if name and name in index_by_name:
            merged[index_by_name[name]] = entry
            replaced += 1
            continue
        merged.append(entry)
        if name:
            index_by_name[name] = len(merged) - 1
        appended += 1
    return merged, replaced, appended


def extract_first(record: dict[str, Any], paths: Iterable[tuple[str, ...]]) -> Optional[str]:
    for path in paths:
        current: Any = record
        valid = True
        for key in path:
            if isinstance(current, dict) and key in current:
                current = current[key]
            else:
                valid = False
                break
        if not valid:
            continue
        if isinstance(current, str):
            value = current.strip()
            if value:
                return value
    return None


def extract_geo(record: Any) -> tuple[Optional[str], Optional[str]]:
    if not isinstance(record, dict):
        return None, None

    country = extract_first(
        record,
        (
            ("country_code",),
            ("country",),
            ("countryCode",),
            ("country_name",),
            ("country", "iso_code"),
            ("country", "names", "en"),
        ),
    )
    city = extract_first(
        record,
        (
            ("city_name",),
            ("city",),
            ("cityName",),
            ("city", "names", "en"),
        ),
    )
    if country and len(country) == 2:
        country = country.upper()
    return country, city


def geo_city_status(mmdb_reader: Any, ip: str) -> tuple[bool, Optional[str], Optional[str], str]:
    try:
        record = mmdb_reader.get(ip)
    except Exception:
        return True, None, None, "lookup_error"
    country, city = extract_geo(record)
    if city:
        return False, country, city, "has_geo"
    return True, country, None, "missing_city"


def is_unknown_geo(mmdb_reader: Any, ip: str) -> bool:
    is_unknown, _country, _city, _status = geo_city_status(mmdb_reader, ip)
    # User requirement: "unknown geo" means missing city only.
    return is_unknown


def fetch_unknown_candidates(unknown_ips_url: str, maintenance_token: str) -> list[IpCandidate]:
    try:
        request = Request(
            unknown_ips_url,
            headers={
                "Accept": "application/json",
                "X-Token": maintenance_token,
            },
        )
        with urlopen(request, timeout=RULES_URL_TIMEOUT_SECONDS) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except URLError as exc:
        raise ValueError(f"Failed to load unknown IPs URL {unknown_ips_url}: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise ValueError(f"Unknown IPs URL did not return valid JSON: {exc}") from exc

    if not isinstance(payload, list):
        raise ValueError("Unknown IPs API response must be a JSON array of IP strings")

    out: list[IpCandidate] = []
    seen: set[str] = set()
    for index, item in enumerate(payload):
        if not isinstance(item, str):
            raise ValueError(
                f"Unknown IPs API response item #{index + 1} must be a string IP, got {type(item).__name__}"
            )
        ip = normalize_ip(item)
        if not ip or not is_public_ip(ip) or ip in seen:
            continue
        seen.add(ip)
        out.append(IpCandidate(ip=ip))
    return out


def run_cmd(args: list[str], timeout: int) -> tuple[int, str, str]:
    try:
        completed = subprocess.run(
            args,
            check=False,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except FileNotFoundError:
        return 127, "", f"command not found: {args[0]}"
    except subprocess.TimeoutExpired:
        return 124, "", f"timeout after {timeout}s"

    return completed.returncode, completed.stdout or "", completed.stderr or ""


def maybe_log_dig_error(label: str, args: list[str], code: int, err: str) -> None:
    global dig_error_logged
    if code == 0 or dig_error_logged >= DIG_ERROR_LOG_LIMIT:
        return
    dig_error_logged += 1
    stderr_line = (err or "").strip().splitlines()
    stderr_sample = stderr_line[0] if stderr_line else "-"
    eprint(
        "dig_error "
        f"label={label} code={code} stderr={stderr_sample} cmd={' '.join(args)}"
    )


def doh_lookup(qname: str, qtype: str) -> list[str]:
    global doh_error_logged, doh_failure_streak, doh_disabled
    if doh_disabled:
        return []

    endpoint = (os.getenv("RDNS_DOH_URL") or DEFAULT_DOH_URL).strip()
    if not endpoint:
        return []

    query = urlencode({"name": qname, "type": qtype})
    url = f"{endpoint}?{query}"
    request = Request(
        url,
        headers={
            "Accept": "application/dns-json",
            "User-Agent": "rdns_geo/1",
        },
    )
    try:
        with urlopen(request, timeout=DOH_TIMEOUT_SECONDS) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (URLError, TimeoutError, HTTPError, json.JSONDecodeError) as exc:
        doh_failure_streak += 1
        if doh_error_logged < DOH_ERROR_LOG_LIMIT:
            doh_error_logged += 1
            eprint(
                "doh_error "
                f"qtype={qtype} name={qname} "
                f"reason={type(exc).__name__}: {exc}"
            )
        if doh_failure_streak >= DOH_FAILURE_DISABLE_AFTER:
            doh_disabled = True
            eprint(
                "doh_disabled "
                f"failures={doh_failure_streak} "
                "reason=consecutive_lookup_failures"
            )
        return []

    doh_failure_streak = 0
    if not isinstance(payload, dict):
        return []
    status = payload.get("Status")
    if status not in (0, "0", None):
        return []

    answers = payload.get("Answer")
    if not isinstance(answers, list):
        doh_failure_streak = 0
        return []

    out: list[str] = []
    for answer in answers:
        if not isinstance(answer, dict):
            continue
        data = answer.get("data")
        if not isinstance(data, str):
            continue
        value = data.strip()
        if value:
            out.append(value)
    doh_failure_streak = 0
    return out


def ptr_lookup_resolver(ip: str) -> str:
    try:
        host = socket.gethostbyaddr(ip)[0]
    except (OSError, socket.herror):
        return ""
    normalized = normalize_ptr_hostname(host)
    return normalized or ""


def is_ip_token(token: str) -> bool:
    cleaned = token.strip().strip("()[]{}<>|,;")
    if not cleaned:
        return False
    try:
        ipaddress.ip_address(cleaned)
        return True
    except ValueError:
        return False


def parse_hops_from_mtr_json(raw: str) -> list[Optional[str]]:
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        return []

    hubs = payload.get("report", {}).get("hubs")
    if not isinstance(hubs, list):
        return []
    hops: list[Optional[str]] = []
    for hub in hubs:
        if not isinstance(hub, dict):
            continue
        host = str(hub.get("host") or "").strip()
        if host and is_ip_token(host):
            hops.append(host)
        else:
            hops.append(None)
    return hops


def parse_hops_from_mtr_text(raw: str) -> list[Optional[str]]:
    hops: list[Optional[str]] = []
    for line in raw.splitlines():
        if not re.match(r"^\s*\d+\.\|\-\-", line):
            continue
        if "???" in line:
            hops.append(None)
            continue
        found_ip: Optional[str] = None
        for token in re.split(r"\s+", line.strip()):
            if not token:
                continue
            t = token.strip().strip("()[]{}<>|,;")
            if is_ip_token(t):
                found_ip = t
                break
        hops.append(found_ip)
    return hops


def select_tail_hops(hops: list[Optional[str]], ratio: float = HOP_TAIL_RATIO) -> list[Optional[str]]:
    if not hops:
        return []
    count = max(1, int(math.ceil(len(hops) * ratio)))
    return hops[-count:]


def build_ranked_tail_hops(hops: list[Optional[str]]) -> tuple[list[HopEvidence], int]:
    tail_hops = select_tail_hops(hops)
    ranked: list[HopEvidence] = []
    for offset, hop_ip in enumerate(reversed(tail_hops)):
        if not hop_ip:
            continue
        ranked.append(
            HopEvidence(
                hop_ip=hop_ip,
                ptr="",
                priority=offset + 1,
                distance=-offset,
            )
        )
    return ranked, len(tail_hops)


def mtr_last_hops(dest_ip: str) -> tuple[list[HopEvidence], int, int]:
    common = [
        "mtr",
        "--report",
        "--report-cycles",
        str(MTR_CYCLES),
        "--no-dns",
    ]

    code, out, _err = run_cmd(common + [dest_ip], timeout=MTR_TIMEOUT_SECONDS)
    if code == 0:
        hops = parse_hops_from_mtr_text(out)
        if hops:
            ranked, tail_count = build_ranked_tail_hops(hops)
            return ranked, len(hops), tail_count

    code, out, _err = run_cmd(common + ["--json", dest_ip], timeout=MTR_TIMEOUT_SECONDS)
    if code != 0:
        return [], 0, 0
    hops = parse_hops_from_mtr_json(out)
    ranked, tail_count = build_ranked_tail_hops(hops)
    return ranked, len(hops), tail_count


def ptr_lookup(ip: str) -> str:
    dig_had_error = False
    if dig_cmd_available:
        short_cmd = ["dig", "+time=2", "+tries=1", "+short", "-x", ip]
        code, out, err = run_cmd(short_cmd, timeout=DIG_TIMEOUT_SECONDS)
        maybe_log_dig_error("ptr_short", short_cmd, code, err)
        if code == 0:
            for line in out.splitlines():
                ptr = line.strip().strip('"').rstrip(".")
                if ptr and not ptr.startswith(";"):
                    return ptr
        else:
            dig_had_error = True

        answer_cmd = ["dig", "+time=2", "+tries=1", "+noall", "+answer", "-x", ip]
        code, out, err = run_cmd(answer_cmd, timeout=DIG_TIMEOUT_SECONDS)
        maybe_log_dig_error("ptr_answer", answer_cmd, code, err)
        if code == 0:
            for line in out.splitlines():
                text = line.strip()
                if not text:
                    continue
                match = re.search(r"\bPTR\s+(\S+)\.?$", text, flags=re.IGNORECASE)
                if match:
                    return match.group(1).strip().rstrip(".")
        else:
            dig_had_error = True

    if dig_had_error or not dig_cmd_available:
        try:
            qname = ipaddress.ip_address(ip).reverse_pointer
        except ValueError:
            qname = ""
        if qname:
            for value in doh_lookup(qname, "PTR"):
                ptr = value.strip().strip('"').rstrip(".")
                if ptr and not ptr.startswith(";"):
                    return ptr

        ptr = ptr_lookup_resolver(ip)
        if ptr:
            return ptr
    return ""


def normalize_ptr_hostname(ptr: str) -> Optional[str]:
    host = (ptr or "").strip().strip(".").lower()
    return host or None


def root_domain(host: str) -> str:
    labels = [part for part in host.split(".") if part]
    if len(labels) <= 2:
        return host
    second_level_like = {"co", "com", "net", "org", "gov", "ac", "edu"}
    cctld_like = {"uk", "au", "nz", "jp", "za", "br", "tr"}
    if len(labels) >= 3 and labels[-1] in cctld_like and labels[-2] in second_level_like:
        return ".".join(labels[-3:])
    return ".".join(labels[-2:])


def build_unmatched_host_records(entries: set[tuple[str, str]]) -> list[UnmatchedHostRecord]:
    by_hostname: dict[str, UnmatchedHostRecord] = {}
    for _ip, hostname in entries:
        normalized = normalize_ptr_hostname(hostname)
        if not normalized or normalized == "-":
            continue
        if normalized not in by_hostname:
            by_hostname[normalized] = UnmatchedHostRecord(
                hostname=normalized,
                domain=root_domain(normalized),
            )
    return sorted(by_hostname.values(), key=lambda item: item.hostname)


def filter_unmatched_entries_by_hostname(
    entries: set[tuple[str, str]],
    hostnames: set[str],
) -> set[tuple[str, str]]:
    if not hostnames:
        return set()
    out: set[tuple[str, str]] = set()
    for ip, hostname in entries:
        normalized = normalize_ptr_hostname(hostname)
        if normalized and normalized in hostnames:
            out.add((ip, normalized))
    return out


def preflight_postgres_tracking(pgsql_dsn: str, table_name: str) -> PgTableRef:
    table_ref = parse_pg_table_ref(table_name)
    conn: Any = None
    try:
        conn = open_postgres_connection(pgsql_dsn)
        ensure_postgres_unmatched_table(conn, table_ref)
        validate_postgres_unmatched_table(conn, table_ref)
    finally:
        if conn is not None:
            conn.close()
    return table_ref


def ensure_postgres_unmatched_table(conn: Any, table_ref: PgTableRef) -> None:
    ensure_hostname_reviews_table(conn, table_ref)


def validate_postgres_unmatched_table(conn: Any, table_ref: PgTableRef) -> None:
    validate_hostname_reviews_table(conn, table_ref)


def fetch_existing_postgres_hostnames(
    conn: Any,
    table_ref: PgTableRef,
    hostnames: list[str],
) -> set[str]:
    if not hostnames:
        return set()
    existing: set[str] = set()
    with conn.cursor() as cur:
        batch_size = 500
        for start in range(0, len(hostnames), batch_size):
            chunk = hostnames[start : start + batch_size]
            placeholders = ",".join("%s" for _ in chunk)
            cur.execute(
                f"SELECT hostname FROM {table_ref.quoted} WHERE hostname IN ({placeholders})",
                chunk,
            )
            for row in cur.fetchall():
                if not row or not isinstance(row[0], str):
                    continue
                normalized = normalize_ptr_hostname(row[0])
                if normalized:
                    existing.add(normalized)
    return existing


def insert_unmatched_postgres_records(
    conn: Any,
    table_ref: PgTableRef,
    records: list[UnmatchedHostRecord],
) -> int:
    if not records:
        return 0

    inserted = 0
    with conn.cursor() as cur:
        for record in records:
            cur.execute(
                f"""
                INSERT INTO {table_ref.quoted} (hostname, domain)
                VALUES (%s, %s)
                ON CONFLICT(hostname) DO NOTHING
                """,
                (record.hostname, record.domain),
            )
            inserted += max(0, int(cur.rowcount or 0))
    conn.commit()
    return inserted


def match_ptr(ptr: str, rules: list[Rule]) -> Optional[Rule]:
    hostname = normalize_ptr_hostname(ptr)
    if not hostname:
        return None
    for rule in rules:
        if rule.domains:
            domain_match = False
            for domain in rule.domains:
                if hostname == domain or hostname.endswith(f".{domain}"):
                    domain_match = True
                    break
            if not domain_match:
                continue
        if rule.pattern.search(hostname):
            return rule
    return None


def cymru_query_name(ip: str) -> str:
    addr = ipaddress.ip_address(ip)
    if addr.version == 4:
        octets = ip.split(".")
        return ".".join(reversed(octets)) + ".origin.asn.cymru.com"
    # IPv6 nibble format
    hex_nibbles = addr.exploded.replace(":", "")
    return ".".join(reversed(hex_nibbles)) + ".origin6.asn.cymru.com"


def parse_cymru_txt(raw: str) -> tuple[Optional[str], Optional[str], Optional[str]]:
    for line in raw.splitlines():
        txt = line.strip().strip('"')
        if not txt:
            continue
        parts = [part.strip() for part in txt.split("|")]
        if len(parts) < 2:
            continue
        asn_match = re.search(r"\d+", parts[0])
        asn = asn_match.group(0) if asn_match else None
        prefix = parts[1].split()[0] if parts[1] else None
        country = parts[2] if len(parts) > 2 else ""
        if not asn or not prefix:
            continue
        try:
            ipaddress.ip_network(prefix, strict=False)
        except ValueError:
            continue
        return asn, prefix, country
    return None, None, None


def normalize_cymru_prefix(ip: str, prefix: str) -> Optional[str]:
    try:
        addr = ipaddress.ip_address(ip)
        network = ipaddress.ip_network(prefix, strict=False)
    except ValueError:
        return None

    if addr.version != network.version:
        return None

    if addr.version == 4 and network.prefixlen < CYMRU_MIN_PREFIXLEN_V4:
        return str(ipaddress.ip_network(f"{addr}/{CYMRU_MIN_PREFIXLEN_V4}", strict=False))
    return str(network)


def team_cymru_origin(ip: str) -> tuple[Optional[str], Optional[str], Optional[str]]:
    qname = cymru_query_name(ip)
    out = ""

    if dig_cmd_available:
        cmd = ["dig", "+time=2", "+tries=1", "+short", "TXT", qname]
        code, out, err = run_cmd(cmd, timeout=DIG_TIMEOUT_SECONDS)
        maybe_log_dig_error("cymru_txt", cmd, code, err)

    asn, prefix, country = parse_cymru_txt(out)
    if not asn or not prefix:
        doh_txt = "\n".join(doh_lookup(qname, "TXT"))
        if doh_txt:
            asn, prefix, country = parse_cymru_txt(doh_txt)

    if not asn or not prefix:
        return None, None, None
    normalized_prefix = normalize_cymru_prefix(ip, prefix)
    if not normalized_prefix:
        return None, None, None
    return asn, normalized_prefix, country


def better_hint(left: Hint, right: Hint) -> Hint:
    if right.evidence.priority < left.evidence.priority:
        return right
    if right.evidence.priority > left.evidence.priority:
        return left
    return left


def existing_geofeed_prefixes(path: Path) -> set[str]:
    if not path.exists():
        return set()

    prefixes: set[str] = set()
    with path.open("r", encoding="utf-8", newline="") as f:
        rows = (line for line in f if line.strip() and not line.lstrip().startswith("#"))
        reader = csv.reader(rows)
        for row in reader:
            if not row:
                continue
            prefix = (row[0] or "").strip()
            if prefix:
                prefixes.add(prefix)
    return prefixes


def file_ends_with_newline(path: Path) -> bool:
    if not path.exists() or path.stat().st_size == 0:
        return True
    with path.open("rb") as f:
        f.seek(-1, 2)
        return f.read(1) == b"\n"


def write_geofeed(path: Path, hints: dict[str, Hint]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    existing_prefixes = existing_geofeed_prefixes(path)
    prefixes_to_append = [prefix for prefix in sorted(hints) if prefix not in existing_prefixes]
    if not prefixes_to_append:
        return

    needs_separator = path.exists() and path.stat().st_size > 0 and not file_ends_with_newline(path)
    with path.open("w", encoding="utf-8", newline="") as f:
        if needs_separator:
            f.write("\n")
        writer = csv.writer(f)
        for prefix in prefixes_to_append:
            hint = hints[prefix]
            f.write(
                "# "
                f"ip={hint.destination_ip} "
                f"hostname={hint.evidence.ptr or '-'} "
                f"distance={hint.evidence.distance} "
                f"total_hops={hint.total_hops} "
                f"source={hint.match_source} "
                f"match={hint.matched_rule}\n"
            )
            writer.writerow([hint.prefix, hint.country, "", hint.city])


def write_unmatched_entries(path: Path, entries: set[tuple[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        for ip, hostname in sorted(entries):
            normalized_hostname = normalize_ptr_hostname(hostname)
            if not normalized_hostname or normalized_hostname == "-":
                continue
            f.write(f"{ip} {normalized_hostname}\n")


def ensure_tool(name: str) -> None:
    if shutil.which(name):
        return
    raise RuntimeError(f"Required command is missing from PATH: {name}")


def main() -> int:
    global dig_cmd_available
    parser = argparse.ArgumentParser(
        description="Infer missing geo hints from rDNS patterns on the last 25% of mtr hops.",
    )
    parser.add_argument(
        "--unknown-ips",
        required=True,
        type=str,
        help="Required URL for unknown IP API endpoint that returns a JSON array of IP strings.",
    )
    parser.add_argument("-mmdb", "--mmdb", required=True, type=Path, help="Geo MMDB path")
    parser.add_argument("-o", "--output", required=True, type=Path, help="Output geofeed CSV path")
    parser.add_argument(
        "-u",
        "--unmatched-zones",
        type=Path,
        default=None,
        help="Write checked non-matching destination IP + PTR hostname pairs (one unique pair per line)",
    )
    parser.add_argument(
        "--test-ip",
        type=str,
        default=None,
        help="Process only this exact IP and skip unknown IP API candidate scan",
    )
    parser.add_argument(
        "--rules-url",
        type=str,
        default=DEFAULT_RULES_URL,
        help=(
            "Rules JSON URL (file://, http://, https://). "
            "Defaults to the local rdns_geo_rules.json file URL"
        ),
    )
    parser.add_argument(
        "--pgsql",
        type=str,
        default="",
        help="Optional PostgreSQL DSN (overrides PGSQL env var) for unmatched hostname tracking",
    )
    parser.add_argument(
        "--pgsql-table",
        type=str,
        default=DEFAULT_PGSQL_TABLE,
        help=f"PostgreSQL table for unmatched hostnames (default: {DEFAULT_PGSQL_TABLE})",
    )
    args = parser.parse_args()
    pgsql_dsn = (args.pgsql or os.getenv("PGSQL") or "").strip()
    unknown_ips_url = (args.unknown_ips or "").strip()
    maintenance_token = (os.getenv("MAINTENANCE_TOKEN") or "").strip()
    pgsql_table_ref: Optional[PgTableRef] = None
    pgsql_rules_table_ref: Optional[PgTableRef] = None

    if maxminddb is None:
        eprint("Missing Python package 'maxminddb'. Install: pip install maxminddb")
        return 2
    if not args.mmdb.exists():
        eprint(f"MMDB file not found: {args.mmdb}")
        return 2
    if not unknown_ips_url:
        eprint("--unknown-ips is required")
        return 2
    unknown_ips_parsed = urlparse(unknown_ips_url)
    if unknown_ips_parsed.scheme not in ("http", "https"):
        eprint(f"--unknown-ips must be http:// or https:// URL, got: {unknown_ips_url}")
        return 2
    if not maintenance_token:
        eprint("Missing MAINTENANCE_TOKEN environment variable")
        return 2

    try:
        ensure_tool("mtr")
        dig_cmd_available = bool(shutil.which("dig"))
        if not dig_cmd_available:
            eprint("warning: dig is not available, using DoH/resolver fallback for DNS lookups")
        file_rule_entries = load_rule_entries_from_url(args.rules_url)
        pgsql_rule_entries: list[dict[str, Any]] = []
        pgsql_rules_skipped = 0
        if pgsql_dsn:
            pgsql_table_ref = preflight_postgres_tracking(pgsql_dsn, args.pgsql_table)
            pgsql_rules_table_ref = parse_pg_table_ref(DEFAULT_PGSQL_RULES_TABLE)
            pgsql_rule_entries, pgsql_rules_skipped = load_rule_entries_from_postgres(
                pgsql_dsn,
                pgsql_rules_table_ref,
            )
        merged_rule_entries, merged_rules_replaced, merged_rules_appended = merge_rule_entries(
            file_rule_entries,
            pgsql_rule_entries,
        )
        rules = compile_rules(merged_rule_entries, "merged rules")
    except Exception as exc:
        eprint(str(exc))
        return 2

    eprint(f"rules_url={args.rules_url}")
    eprint(f"loaded_rules_file={len(file_rule_entries)}")
    eprint(f"loaded_rules_pgsql={len(pgsql_rule_entries)}")
    eprint(f"loaded_rules_total={len(rules)}")
    if pgsql_dsn and pgsql_rules_table_ref is not None:
        eprint(
            "pgsql_rules_merge "
            f"table={pgsql_rules_table_ref.schema}.{pgsql_rules_table_ref.table} "
            f"replaced={merged_rules_replaced} appended={merged_rules_appended} "
            f"skipped={pgsql_rules_skipped}"
        )

    hints_by_prefix: dict[str, Hint] = {}
    unknown_candidates: list[IpCandidate] = []

    if args.test_ip:
        test_ip = normalize_ip(args.test_ip)
        if not test_ip:
            eprint(f"Invalid --test-ip value: {args.test_ip}")
            return 2
        unknown_candidates = [IpCandidate(ip=test_ip)]
        eprint(f"test_ip_mode ip={test_ip}")
    else:
        with maxminddb.open_database(str(args.mmdb)) as reader:
            all_candidates = fetch_unknown_candidates(unknown_ips_url, maintenance_token)
            eprint(
                f"api_candidates_public_unique={len(all_candidates)} "
                f"selection_limit={DEFAULT_SCAN_LIMIT}"
            )
            for candidate in all_candidates:
                is_unknown, country, city, geo_status = geo_city_status(reader, candidate.ip)
                eprint(
                    f"geo_check ip={candidate.ip} status={geo_status} "
                    f"country={country or '-'} city={city or '-'}"
                )
                if is_unknown:
                    unknown_candidates.append(candidate)
                if len(unknown_candidates) >= DEFAULT_SCAN_LIMIT:
                    break
        eprint(f"unknown_geo_candidates={len(unknown_candidates)}")

    processed = 0
    unmatched = 0
    matched = 0
    matched_via_mmdb = 0
    matched_via_rules = 0
    cymru_missing = 0
    country_conflicts = 0
    country_missing = 0
    skipped_no_hops = 0
    unmatched_entries: set[tuple[str, str]] = set()

    with maxminddb.open_database(str(args.mmdb)) as hop_geo_reader:
        for candidate in unknown_candidates:
            processed += 1
            eprint(f"[{processed}/{len(unknown_candidates)}] checking_ip={candidate.ip}")

            ranked_hops, total_hops, tail_hops_count = mtr_last_hops(candidate.ip)
            if not ranked_hops:
                skipped_no_hops += 1
                eprint("  result=no_hops")
                continue
            eprint(
                "  "
                f"hops_total={total_hops} "
                f"hops_tail25_count={tail_hops_count} "
                f"hops_tail25_ip_count={len(ranked_hops)} "
                f"hops_tail25={','.join(entry.hop_ip for entry in ranked_hops)}"
            )

            matched_evidence: Optional[HopEvidence] = None
            matched_source = ""
            matched_ref = ""
            matched_country_code = ""
            matched_city = ""
            local_checked_unmatched: set[tuple[str, str, str]] = set()
            for evidence in ranked_hops:
                _hop_unknown, hop_country, hop_city, _hop_geo_status = geo_city_status(
                    hop_geo_reader, evidence.hop_ip
                )
                if hop_city:
                    evidence.ptr = ptr_lookup(evidence.hop_ip)
                    matched_evidence = evidence
                    matched_source = "mmdb"
                    matched_ref = "mmdb_hop_city"
                    matched_country_code = normalize_country_code(hop_country)
                    matched_city = hop_city
                    break

                ptr = ptr_lookup(evidence.hop_ip)
                evidence.ptr = ptr
                normalized_hostname = normalize_ptr_hostname(ptr)
                hostname = normalized_hostname or "-"
                rule = match_ptr(ptr, rules)
                if rule:
                    matched_evidence = evidence
                    matched_source = "rules"
                    matched_ref = rule.name
                    matched_country_code = normalize_country_code(rule.country)
                    matched_city = rule.city
                    break
                local_checked_unmatched.add((candidate.ip, evidence.hop_ip, hostname))
                if normalized_hostname:
                    unmatched_entries.add((candidate.ip, normalized_hostname))

            if not matched_source or not matched_evidence:
                unmatched += 1
                eprint("  result=unmatched_mmdb_and_ptr_rules")
                if not local_checked_unmatched:
                    triple = (candidate.ip, "-", "-")
                    local_checked_unmatched.add(triple)
                for dest_ip, hop_ip, hostname in sorted(local_checked_unmatched):
                    print(f"UNMATCHED dst_ip={dest_ip} hop_ip={hop_ip} hostname={hostname}")
                continue
            if local_checked_unmatched:
                eprint(f"  non_matching_checked_before_match={len(local_checked_unmatched)}")
            eprint(
                "  hop_match="
                f"source={matched_source} match={matched_ref} "
                f"country={matched_country_code or '-'} city={matched_city} "
                f"evidence_hop={matched_evidence.hop_ip} evidence_ptr={matched_evidence.ptr or '-'}"
            )

            asn, prefix, cymru_country = team_cymru_origin(candidate.ip)
            if not asn or not prefix:
                cymru_missing += 1
                eprint("  result=cymru_miss")
                continue
            cymru_country_code = normalize_country_code(cymru_country)
            inferred_country_code = matched_country_code
            if (
                cymru_country_code
                and inferred_country_code
                and inferred_country_code != cymru_country_code
            ):
                country_conflicts += 1
                eprint(
                    "  result=country_conflict "
                    f"inferred_country={inferred_country_code} "
                    f"cymru_country={cymru_country_code} "
                    f"ip={candidate.ip} "
                    f"prefix={prefix} "
                    f"asn={asn} "
                    f"ptr={matched_evidence.ptr or '-'} "
                    f"source={matched_source} match={matched_ref}"
                )
                continue

            final_country_code = inferred_country_code or cymru_country_code
            if not final_country_code:
                country_missing += 1
                eprint(
                    "  result=missing_country "
                    f"ip={candidate.ip} ptr={matched_evidence.ptr or '-'} "
                    f"source={matched_source} match={matched_ref}"
                )
                continue
            if not inferred_country_code and cymru_country_code:
                eprint(
                    "  country_fallback=using_cymru "
                    f"cymru_country={cymru_country_code} "
                    f"source={matched_source} match={matched_ref}"
                )

            hint = Hint(
                prefix=prefix,
                country=final_country_code,
                city=matched_city,
                destination_ip=candidate.ip,
                total_hops=total_hops,
                cymru_asn=asn,
                cymru_country=cymru_country or "",
                match_source=matched_source,
                matched_rule=matched_ref,
                evidence=matched_evidence,
            )
            current = hints_by_prefix.get(prefix)
            hints_by_prefix[prefix] = hint if current is None else better_hint(current, hint)
            matched += 1
            if matched_source == "mmdb":
                matched_via_mmdb += 1
            else:
                matched_via_rules += 1
            eprint(
                f"  result=matched prefix={prefix} asn={asn} "
                f"cymru_country={cymru_country or '-'} "
                f"source={matched_source} match={matched_ref}"
            )

    entries_for_dump = unmatched_entries
    pgsql_tracked_hosts = 0
    pgsql_existing_hosts = 0
    pgsql_new_hosts = 0
    pgsql_inserted_hosts = 0
    if pgsql_dsn and pgsql_table_ref is not None:
        try:
            host_records = build_unmatched_host_records(unmatched_entries)
            pgsql_tracked_hosts = len(host_records)
            hostnames = [record.hostname for record in host_records]
            existing_hostnames: set[str] = set()
            new_host_records: list[UnmatchedHostRecord] = host_records
            pg_conn: Any = None
            try:
                pg_conn = open_postgres_connection(pgsql_dsn)
                existing_hostnames = fetch_existing_postgres_hostnames(
                    pg_conn,
                    pgsql_table_ref,
                    hostnames,
                )
                pgsql_existing_hosts = len(existing_hostnames)
                new_host_records = [
                    record for record in host_records if record.hostname not in existing_hostnames
                ]
                pgsql_new_hosts = len(new_host_records)
                pgsql_inserted_hosts = insert_unmatched_postgres_records(
                    pg_conn,
                    pgsql_table_ref,
                    new_host_records,
                )
            finally:
                if pg_conn is not None:
                    pg_conn.close()
            if args.unmatched_zones:
                entries_for_dump = filter_unmatched_entries_by_hostname(
                    unmatched_entries,
                    {record.hostname for record in new_host_records},
                )
        except Exception as exc:
            eprint(f"postgres_tracking_error: {exc}")
            return 2

    write_geofeed(args.output, hints_by_prefix)
    if args.unmatched_zones:
        write_unmatched_entries(args.unmatched_zones, entries_for_dump)

    eprint(
        "DONE:",
        f"processed={processed}",
        f"matched={matched}",
        f"matched_mmdb={matched_via_mmdb}",
        f"matched_rules={matched_via_rules}",
        f"unmatched={unmatched}",
        f"cymru_missing={cymru_missing}",
        f"country_conflicts={country_conflicts}",
        f"country_missing={country_missing}",
        f"no_hops={skipped_no_hops}",
        f"prefixes={len(hints_by_prefix)}",
        f"unmatched_ptr_entries={len(unmatched_entries)}",
        f"unmatched_dump_entries={len(entries_for_dump)}",
        f"pgsql_tracked_hosts={pgsql_tracked_hosts}",
        f"pgsql_existing_hosts={pgsql_existing_hosts}",
        f"pgsql_new_hosts={pgsql_new_hosts}",
        f"pgsql_inserted_hosts={pgsql_inserted_hosts}",
    )
    eprint(f"Checked {processed} ips, Found new entries: {len(hints_by_prefix)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
