#!/usr/bin/env python3
"""
Derive geofeed hints for unknown-geo destination IPs from ip_records.

Pipeline:
1) Read destination IPs from SQLite ip_records.
2) Keep only public IPs with unknown geo in MMDB.
3) Run mtr in numeric mode to collect hops.
4) Resolve PTR for the last 25% of hops (closest hop has highest priority).
5) Match PTR names against a regex rule dictionary to infer country/city.
6) Confirm destination ASN/prefix via Team Cymru DNS.
7) Write derived geofeed rows.
"""

from __future__ import annotations

import argparse
import csv
import ipaddress
import json
import math
import re
import shutil
import sqlite3
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Optional

try:
    import maxminddb
except ImportError:  # pragma: no cover - runtime guard
    maxminddb = None

HOP_TAIL_RATIO = 0.25
DEFAULT_SCAN_LIMIT = 1000
MTR_CYCLES = 1
MTR_TIMEOUT_SECONDS = 30
DIG_TIMEOUT_SECONDS = 8


# Rule design policy:
# - Prefer delimiter-bounded location tokens (., -, _) over raw substrings.
# - Prefer provider/domain-scoped rules for ambiguous tokens.
# - Avoid exact hostname/service rules unless there is no safer alternative.
DEFAULT_RULES = [
    {
        "name": "comcast_newark_nj",
        "pattern": r"(^|[^a-z0-9])newark([^a-z0-9]|$)",
        "domains": ["comcast.net"],
        "country": "US",
        "city": "Newark",
    },
    {
        "name": "comcast_woburn_ma",
        "pattern": r"(^|[^a-z0-9])woburn([^a-z0-9]|$)",
        "domains": ["comcast.net"],
        "country": "US",
        "city": "Woburn",
    },
    {
        "name": "comcast_boston_ma",
        "pattern": r"(^|[^a-z0-9])boston([^a-z0-9]|$)",
        "domains": ["comcast.net"],
        "country": "US",
        "city": "Boston",
    },
    {
        "name": "comcast_hartford_ct",
        "pattern": r"(^|[^a-z0-9])hartford([^a-z0-9]|$)",
        "domains": ["comcast.net"],
        "country": "US",
        "city": "Hartford",
    },
    {
        "name": "as13285_thw_london",
        "pattern": r"(^|[^a-z0-9])thw([^a-z0-9]|$)",
        "domains": ["as13285.net"],
        "country": "GB",
        "city": "London",
    },
    {
        "name": "as13285_loh_london",
        "pattern": r"(^|[._-])(?:\d+)?loh(?:\d+)?([._-]|$)",
        "domains": ["as13285.net"],
        "country": "GB",
        "city": "London",
    },
    {
        "name": "colt_lon_london",
        "pattern": r"(^|[._-])(?:\d+)?lon(?:\d+)?([._-]|$)",
        "domains": ["colt.net"],
        "country": "GB",
        "city": "London",
    },
    {
        "name": "colt_sof_sofia",
        "pattern": r"(^|[._-])(?:\d+)?sof(?:\d+)?([._-]|$)",
        "domains": ["colt.net"],
        "country": "BG",
        "city": "Sofia",
    },
    {
        "name": "lumen_lon_london",
        "pattern": r"(^|[._-])(?:\d+)?lon(?:\d+)?([._-]|$)",
        "domains": ["lumen.tech"],
        "country": "GB",
        "city": "London",
    },
    {
        "name": "zayo_lga_new_york",
        "pattern": r"(^|[._-])(?:\d+)?lga(?:\d+)?([._-]|$)",
        "domains": ["zayo.com"],
        "country": "US",
        "city": "New York",
    },
    {
        "name": "level3_sofia_sofia",
        "pattern": r"(^|[._-])(?:\d+)?sofia(?:\d+)?([._-]|$)",
        "domains": ["level3.net"],
        "country": "BG",
        "city": "Sofia",
    },
    {
        "name": "as7195_jfk_new_york",
        "pattern": r"(^|[._-])(?:\d+)?jfk(?:\d+)?([._-]|$)",
        "domains": ["as7195.net"],
        "country": "US",
        "city": "New York",
    },
    {
        "name": "as7195_gru_sao_paulo",
        "pattern": r"(^|[._-])(?:\d+)?gru(?:\d+)?([._-]|$)",
        "domains": ["as7195.net"],
        "country": "BR",
        "city": "Sao Paulo",
    },
    {
        "name": "new_york_nyc_token",
        "pattern": r"(^|[^a-z0-9])(nyc\d*|\d+nyc)([^a-z0-9]|$)",
        "country": "US",
        "city": "New York",
    },
    {
        "name": "london_lhr_token",
        "pattern": r"(^|[^a-z0-9])(lhr\d*|\d+lhr)([^a-z0-9]|$)",
        "country": "GB",
        "city": "London",
    },
    {
        "name": "washington_dc_token",
        "pattern": r"(^|[^a-z0-9])(washdc|iad\d*|\d+iad)([^a-z0-9]|$)",
        "country": "US",
        "city": "Washington",
    },
    {
        "name": "newark_ewr_token",
        "pattern": r"(^|[^a-z0-9])(ewr\d*|\d+ewr)([^a-z0-9]|$)",
        "country": "US",
        "city": "Newark",
    },
    {
        "name": "des_moines_token",
        "pattern": r"(^|[^a-z0-9])(desm\d*|\d+desm)([^a-z0-9]|$)",
        "country": "US",
        "city": "Des Moines",
    },
    {
        "name": "toronto_yyz_token",
        "pattern": r"(^|[^a-z0-9])(yyz\d*|\d+yyz)([^a-z0-9]|$)",
        "country": "CA",
        "city": "Toronto",
    },
    {
        "name": "rogers_toronto_ym",
        "pattern": r"(^|[^a-z0-9])ym([^a-z0-9]|$)",
        "domains": ["rogers.com"],
        "country": "CA",
        "city": "Toronto",
    },
    {
        "name": "netins_des_moines_dvnp",
        "pattern": r"(^|[^a-z0-9])(dvnp|desm)([^a-z0-9]|$)",
        "domains": ["netins.net"],
        "country": "US",
        "city": "Des Moines",
    },
    {
        "name": "windstream_grnl_ia_grinnell",
        "pattern": r"(^|[._-])grnl\d*[._-]ia([._-]|$)",
        "domains": ["windstream.net"],
        "country": "US",
        "city": "Grinnell",
    },
    {
        "name": "networklayer_wdc_washington",
        "pattern": r"(^|[._-])wdc\d*([._-]|$)",
        "domains": ["networklayer.com"],
        "country": "US",
        "city": "Washington",
    },
    {
        "name": "verizon_nycmny_new_york",
        "pattern": r"(^|[._-])nycmny\d*([._-]|$)",
        "domains": ["verizon.net", "verizon-gni.net"],
        "country": "US",
        "city": "New York",
    },
    {
        "name": "tpnet_szcz_szczecin",
        "pattern": r"(^|[._-])szcz\d*([._-]|$)",
        "domains": ["tpnet.pl"],
        "country": "PL",
        "city": "Szczecin",
    },
]


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
    hits: int
    last_seen: str


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
    destination_hits: int
    destination_last_seen: str
    total_hops: int
    cymru_asn: str
    cymru_country: str
    matched_rule: str
    evidence: HopEvidence


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


def is_public_ip(ip: str) -> bool:
    try:
        return ipaddress.ip_address(ip).is_global
    except ValueError:
        return False


def load_rules() -> list[Rule]:
    source: list[dict[str, Any]] = DEFAULT_RULES
    rules: list[Rule] = []
    for idx, entry in enumerate(source):
        if not isinstance(entry, dict):
            raise ValueError(f"Rule #{idx + 1} must be an object")
        name = str(entry.get("name") or f"rule_{idx + 1}").strip()
        pattern_text = str(entry.get("pattern") or "").strip()
        domains_raw = entry.get("domains")
        country = str(entry.get("country") or "").strip().upper()
        city = str(entry.get("city") or "").strip()
        if not pattern_text or len(country) != 2 or not city:
            raise ValueError(
                f"Rule #{idx + 1} must include pattern, 2-letter country, and city"
            )
        domains: tuple[str, ...] = ()
        if isinstance(domains_raw, str) and domains_raw.strip():
            domains = (domains_raw.strip().strip(".").lower(),)
        elif isinstance(domains_raw, list):
            normalized_domains: list[str] = []
            for value in domains_raw:
                if not isinstance(value, str):
                    raise ValueError(f"Rule #{idx + 1} has non-string domain in domains")
                domain = value.strip().strip(".").lower()
                if domain:
                    normalized_domains.append(domain)
            domains = tuple(normalized_domains)
        elif domains_raw is not None:
            raise ValueError(f"Rule #{idx + 1} domains must be string or list of strings")
        try:
            pattern = re.compile(pattern_text, re.IGNORECASE)
        except re.error as exc:
            raise ValueError(f"Rule #{idx + 1} invalid regex: {exc}") from exc
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


def query_candidates(db_path: Path, limit: int) -> list[IpCandidate]:
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            """
            SELECT ip, SUM(hits) AS hits, MAX(last_seen) AS last_seen
            FROM ip_records
            WHERE ip IS NOT NULL AND TRIM(ip) != ''
            GROUP BY ip
            ORDER BY hits DESC, last_seen DESC
            """
        )
        out: list[IpCandidate] = []
        for row in rows:
            ip = normalize_ip(str(row["ip"]))
            if not ip or not is_public_ip(ip):
                continue
            hits = int(row["hits"] or 0)
            last_seen = str(row["last_seen"] or "")
            out.append(IpCandidate(ip=ip, hits=hits, last_seen=last_seen))
            if len(out) >= limit:
                break
        return out
    finally:
        conn.close()


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
    # Primary path: explicit reverse-DNS query.
    code, out, _err = run_cmd(
        ["dig", "+time=2", "+tries=1", "+short", "-x", ip],
        timeout=DIG_TIMEOUT_SECONDS,
    )
    if code == 0:
        for line in out.splitlines():
            ptr = line.strip().strip('"').rstrip(".")
            if ptr and not ptr.startswith(";"):
                return ptr

    # Fallback: parse PTR from full answer section when +short path is empty.
    code, out, _err = run_cmd(
        ["dig", "+time=2", "+tries=1", "+noall", "+answer", "-x", ip],
        timeout=DIG_TIMEOUT_SECONDS,
    )
    if code == 0:
        for line in out.splitlines():
            text = line.strip()
            if not text:
                continue
            match = re.search(r"\bPTR\s+(\S+)\.?$", text, flags=re.IGNORECASE)
            if match:
                return match.group(1).strip().rstrip(".")
    return ""


def normalize_ptr_hostname(ptr: str) -> Optional[str]:
    host = (ptr or "").strip().strip(".").lower()
    return host or None


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


def team_cymru_origin(ip: str) -> tuple[Optional[str], Optional[str], Optional[str]]:
    qname = cymru_query_name(ip)
    code, out, _err = run_cmd(
        ["dig", "+time=2", "+tries=1", "+short", "TXT", qname],
        timeout=DIG_TIMEOUT_SECONDS,
    )
    if code != 0:
        return None, None, None
    return parse_cymru_txt(out)


def better_hint(left: Hint, right: Hint) -> Hint:
    if right.evidence.priority < left.evidence.priority:
        return right
    if right.evidence.priority > left.evidence.priority:
        return left
    if right.destination_hits > left.destination_hits:
        return right
    if right.destination_hits < left.destination_hits:
        return left
    if right.destination_last_seen > left.destination_last_seen:
        return right
    return left


def write_geofeed(path: Path, hints: dict[str, Hint]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.writer(f)
        for prefix in sorted(hints):
            hint = hints[prefix]
            f.write(
                "# "
                f"ip={hint.destination_ip} "
                f"hostname={hint.evidence.ptr or '-'} "
                f"distance={hint.evidence.distance} "
                f"total_hops={hint.total_hops}\n"
            )
            writer.writerow([hint.prefix, hint.country, "", hint.city])


def write_unmatched_entries(path: Path, entries: set[tuple[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        for ip, hostname in sorted(entries):
            f.write(f"{ip} {hostname}\n")


def ensure_tool(name: str) -> None:
    if shutil.which(name):
        return
    raise RuntimeError(f"Required command is missing from PATH: {name}")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Infer missing geo hints from rDNS patterns on the last 25% of mtr hops.",
    )
    parser.add_argument("-db", "--db", type=Path, help="SQLite DB path")
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
        help="Process only this exact IP and skip SQLite candidate scan",
    )
    args = parser.parse_args()

    if maxminddb is None:
        eprint("Missing Python package 'maxminddb'. Install: pip install maxminddb")
        return 2
    if not args.mmdb.exists():
        eprint(f"MMDB file not found: {args.mmdb}")
        return 2
    if not args.test_ip:
        if not args.db:
            eprint("SQLite DB path is required unless --test-ip is provided")
            return 2
        if not args.db.exists():
            eprint(f"SQLite DB not found: {args.db}")
            return 2

    try:
        ensure_tool("mtr")
        ensure_tool("dig")
        rules = load_rules()
    except Exception as exc:
        eprint(str(exc))
        return 2

    eprint(f"loaded_rules={len(rules)}")

    hints_by_prefix: dict[str, Hint] = {}
    unknown_candidates: list[IpCandidate] = []

    if args.test_ip:
        test_ip = normalize_ip(args.test_ip)
        if not test_ip:
            eprint(f"Invalid --test-ip value: {args.test_ip}")
            return 2
        unknown_candidates = [IpCandidate(ip=test_ip, hits=0, last_seen="")]
        eprint(f"test_ip_mode ip={test_ip}")
    else:
        with maxminddb.open_database(str(args.mmdb)) as reader:
            all_candidates = query_candidates(args.db, limit=DEFAULT_SCAN_LIMIT * 10)
            eprint(
                f"db_candidates_public_unique={len(all_candidates)} "
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
    cymru_missing = 0
    country_conflicts = 0
    skipped_no_hops = 0
    unmatched_entries: set[tuple[str, str]] = set()

    for candidate in unknown_candidates:
        processed += 1
        eprint(
            f"[{processed}/{len(unknown_candidates)}] checking_ip={candidate.ip} "
        )

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

        matched_rule: Optional[Rule] = None
        matched_evidence: Optional[HopEvidence] = None
        local_checked_unmatched: set[tuple[str, str, str]] = set()
        for evidence in ranked_hops:
            ptr = ptr_lookup(evidence.hop_ip)
            evidence.ptr = ptr
            hostname = normalize_ptr_hostname(ptr) or "-"
            rule = match_ptr(ptr, rules)
            if rule:
                matched_rule = rule
                matched_evidence = evidence
                break
            local_checked_unmatched.add((candidate.ip, evidence.hop_ip, hostname))
            unmatched_entries.add((candidate.ip, hostname))

        if not matched_rule or not matched_evidence:
            unmatched += 1
            eprint("  result=unmatched_ptr_rules")
            if not local_checked_unmatched:
                triple = (candidate.ip, "-", "-")
                local_checked_unmatched.add(triple)
                unmatched_entries.add((candidate.ip, "-"))
            for dest_ip, hop_ip, hostname in sorted(local_checked_unmatched):
                print(f"UNMATCHED dst_ip={dest_ip} hop_ip={hop_ip} hostname={hostname}")
            continue
        if local_checked_unmatched:
            eprint(f"  non_matching_checked_before_match={len(local_checked_unmatched)}")
        eprint(
            "  ptr_match="
            f"{matched_rule.name} country={matched_rule.country} city={matched_rule.city} "
            f"evidence_hop={matched_evidence.hop_ip} evidence_ptr={matched_evidence.ptr or '-'}"
        )

        asn, prefix, cymru_country = team_cymru_origin(candidate.ip)
        if not asn or not prefix:
            cymru_missing += 1
            eprint("  result=cymru_miss")
            continue
        cymru_country_code = (cymru_country or "").strip().upper()
        inferred_country_code = matched_rule.country.strip().upper()
        if (
            cymru_country_code
            and len(cymru_country_code) == 2
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
                f"ptr={matched_evidence.ptr or '-'}"
            )
            continue

        hint = Hint(
            prefix=prefix,
            country=matched_rule.country,
            city=matched_rule.city,
            destination_ip=candidate.ip,
            destination_hits=candidate.hits,
            destination_last_seen=candidate.last_seen,
            total_hops=total_hops,
            cymru_asn=asn,
            cymru_country=cymru_country or "",
            matched_rule=matched_rule.name,
            evidence=matched_evidence,
        )
        current = hints_by_prefix.get(prefix)
        hints_by_prefix[prefix] = hint if current is None else better_hint(current, hint)
        matched += 1
        eprint(
            f"  result=matched prefix={prefix} asn={asn} "
            f"cymru_country={cymru_country or '-'}"
        )

    write_geofeed(args.output, hints_by_prefix)
    if args.unmatched_zones:
        write_unmatched_entries(args.unmatched_zones, unmatched_entries)

    eprint(
        "DONE:",
        f"processed={processed}",
        f"matched={matched}",
        f"unmatched={unmatched}",
        f"cymru_missing={cymru_missing}",
        f"country_conflicts={country_conflicts}",
        f"no_hops={skipped_no_hops}",
        f"prefixes={len(hints_by_prefix)}",
        f"unmatched_ptr_entries={len(unmatched_entries)}",
    )
    eprint(f"Checked {processed} ips, Found new entries: {len(hints_by_prefix)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
