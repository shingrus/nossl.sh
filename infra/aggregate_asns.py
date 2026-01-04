#!/usr/bin/env python3
import argparse
import ipaddress
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


def warn(source: Path, message: str):
    print(f"warning: {source}: {message}", file=sys.stderr)


class IntegrityError(RuntimeError):
    pass


class SkipEntry(RuntimeError):
    pass


def fail(source: Path, message: str):
    raise IntegrityError(f"{source}: {message}")


def skip(source: Path, message: str):
    raise SkipEntry(f"{source}: {message}")


def iter_aggregated(as_dir: Path):
    entries = []
    counter = 0
    skipped = 0
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
        asn_value = data.get("asn", entry.name)
        try:
            asn_number = int(asn_value)
        except (TypeError, ValueError):
            warn(agg_path, f"invalid ASN value {asn_value!r}")
            continue
        if asn_number <= 0:
            warn(agg_path, f"invalid ASN value {asn_value!r}")
            continue
        if str(asn_number) != entry.name:
            warn(
                agg_path,
                f"ASN mismatch (dir {entry.name}, json {asn_value}); skipping",
            )
            skipped += 1
            continue
        try:
            normalized = normalize_asn_record(data, asn_number, agg_path)
            if normalized is None:
                skipped += 1
                continue
            ip_amount, ipv4_amount, ipv6_amount = compute_ip_amounts(
                normalized, agg_path
            )
        except SkipEntry as exc:
            print(f"warning: {exc}", file=sys.stderr)
            skipped += 1
            continue
        except IntegrityError as exc:
            print(f"error: {exc}", file=sys.stderr)
            raise
        entries.append((asn_number, normalized, ip_amount, ipv4_amount, ipv6_amount))
    return sorted(entries, key=lambda item: item[0]), skipped


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
    for asn, data, *_ in entries:
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


def extract_prefixes(data, family: str):
    for container_key in ("prefixes", "subnets"):
        container = data.get(container_key)
        if isinstance(container, dict):
            prefixes = container.get(family)
            if isinstance(prefixes, list):
                return prefixes
    prefixes = data.get(family)
    if isinstance(prefixes, list):
        return prefixes
    return []


def normalize_prefix(prefix):
    if isinstance(prefix, str):
        stripped = prefix.strip()
        return stripped if stripped else None
    if isinstance(prefix, dict):
        for key in ("prefix", "cidr", "network", "subnet"):
            value = prefix.get(key)
            if isinstance(value, str):
                stripped = value.strip()
                return stripped if stripped else None
    return None


def coerce_string(value, source: Path, field: str):
    if value is None:
        return None
    if isinstance(value, str):
        trimmed = value.strip()
        return trimmed if trimmed else None
    warn(source, f"{field} is not a string, coercing")
    return str(value)


def read_prefixes(data, source: Path):
    sources = {}

    def collect_container(container_key: str):
        if container_key not in data:
            return
        container = data.get(container_key)
        if container is None:
            return
        if not isinstance(container, dict):
            fail(source, f"{container_key} is not an object")
        families = {}
        for fam in ("ipv4", "ipv6"):
            if fam not in container:
                continue
            value = container.get(fam)
            if value is None:
                families[fam] = []
                continue
            if not isinstance(value, list):
                fail(source, f"{container_key}.{fam} is not a list")
            families[fam] = value
        if families:
            sources[container_key] = families

    collect_container("prefixes")
    collect_container("subnets")

    top_level = {}
    for fam in ("ipv4", "ipv6"):
        if fam not in data:
            continue
        value = data.get(fam)
        if value is None:
            top_level[fam] = []
            continue
        if not isinstance(value, list):
            fail(source, f"{fam} is not a list")
        top_level[fam] = value
    if top_level:
        sources["top_level"] = top_level

    if not sources:
        fail(source, "missing prefixes/subnets/ipv4/ipv6 data")

    if len(sources) > 1:
        base_key = next(iter(sources))
        base = sources[base_key]
        for key, families in sources.items():
            if key == base_key:
                continue
            if families != base:
                skip(
                    source,
                    f"conflicting prefix sources ({base_key} vs {key}); skipping",
                )

    for key in ("prefixes", "subnets", "top_level"):
        if key in sources:
            return sources[key]
    return {}


def normalize_prefixes(data, family: str, source: Path):
    normalized = []
    families = read_prefixes(data, source)
    entries = families.get(family, [])
    for entry in entries:
        prefix = normalize_prefix(entry)
        if not prefix:
            skip(source, f"invalid {family} prefix entry {entry!r}")
        normalized.append(prefix)
    return normalized


def normalize_metadata(data, source: Path):
    metadata = {}
    raw_metadata = data.get("metadata")
    if raw_metadata is None:
        raw_metadata = {}
    elif not isinstance(raw_metadata, dict):
        skip(source, "metadata is not an object")
    metadata.update(raw_metadata)

    handle = coerce_string(raw_metadata.get("handle"), source, "metadata.handle")
    if handle is None:
        handle = coerce_string(data.get("handle"), source, "handle")
    if handle is not None:
        metadata["handle"] = handle

    description = coerce_string(raw_metadata.get("description"), source, "metadata.description")
    if description is None:
        description = coerce_string(data.get("description"), source, "description")
    if description is None:
        description = coerce_string(data.get("organization"), source, "organization")
    if description is None:
        description = coerce_string(data.get("Organization"), source, "Organization")
    if description is not None:
        metadata["description"] = description

    origin = coerce_string(raw_metadata.get("origin"), source, "metadata.origin")
    if origin is None:
        origin = coerce_string(data.get("origin"), source, "origin")
    if origin is not None:
        metadata["origin"] = origin

    metadata = {key: value for key, value in metadata.items() if value is not None}
    return metadata


def normalize_asn_record(data, asn: int, source: Path):
    if not isinstance(data, dict):
        fail(source, "ASN record is not an object")
    normalized = {
        "asn": asn,
        "metadata": normalize_metadata(data, source),
        "prefixes": {
            "ipv4": normalize_prefixes(data, "ipv4", source),
            "ipv6": normalize_prefixes(data, "ipv6", source),
        },
    }
    if "domain" in data:
        domain = coerce_string(data.get("domain"), source, "domain")
        if domain:
            normalized["domain"] = domain
    return normalized


def count_ip_amount(prefixes, family: str, source: Path):
    total = 0
    for entry in prefixes:
        prefix = normalize_prefix(entry)
        if not prefix:
            skip(source, f"missing {family} prefix")
        try:
            network = ipaddress.ip_network(prefix, strict=False)
        except ValueError as exc:
            skip(source, f"invalid {family} prefix {prefix!r}: {exc}")
        if family == "ipv4" and network.version != 4:
            skip(source, f"unexpected ipv6 prefix in ipv4 list: {prefix!r}")
        if family == "ipv6" and network.version != 6:
            skip(source, f"unexpected ipv4 prefix in ipv6 list: {prefix!r}")
        total += int(network.num_addresses)
    return total


def compute_ip_amounts(data, source: Path):
    ipv4_amount = count_ip_amount(extract_prefixes(data, "ipv4"), "ipv4", source)
    ipv6_amount = count_ip_amount(extract_prefixes(data, "ipv6"), "ipv6", source)
    return ipv4_amount + ipv6_amount, ipv4_amount, ipv6_amount


def strip_ip_amounts(data):
    for key in ("ip_amount", "ipv4_amount", "ipv6_amount"):
        data.pop(key, None)


def extract_handle(data):
    metadata = data.get("metadata")
    if isinstance(metadata, dict) and metadata.get("handle") is not None:
        return str(metadata.get("handle"))
    handle = data.get("handle")
    if handle is None:
        return None
    return str(handle)


def extract_organization(data):
    metadata = data.get("metadata")
    if isinstance(metadata, dict):
        value = metadata.get("description")
        if value is not None:
            return str(value)
    for key in ("organization", "Organization", "description"):
        value = data.get(key)
        if value is not None:
            return str(value)
    return None


def ensure_column(connection, table: str, name: str, ddl: str):
    columns = {
        row[1] for row in connection.execute(f"PRAGMA table_info({table})")
    }
    if name not in columns:
        connection.execute(f"ALTER TABLE {table} ADD COLUMN {ddl}")


def format_ip_amount(value):
    if value is None:
        return None
    return str(value)


def format_ipv6_amount_millions(value):
    if value is None:
        return None
    million = 1_000_000
    whole = value // million
    remainder = value % million
    rounded = (remainder * 100 + million // 2) // million
    if rounded >= 100:
        whole += 1
        rounded = 0
    return f"{whole}.{rounded:02d}"


def write_sqlite(entries, output_path: Path):
    connection = sqlite3.connect(output_path)
    try:
        with connection:
            connection.execute(
                "CREATE TABLE IF NOT EXISTS asn ("
                "asn INTEGER PRIMARY KEY, "
                "handle TEXT, "
                "organization TEXT, "
                "ip_amount int8, "
                "ipv4_amount int8, "
                "ipv6_amount REAL, "
                "json TEXT NOT NULL"
                ")"
            )
            ensure_column(connection, "asn", "handle", "handle TEXT")
            ensure_column(connection, "asn", "organization", "organization TEXT")
            ensure_column(connection, "asn", "ip_amount", "ip_amount int8")
            ensure_column(connection, "asn", "ipv4_amount", "ipv4_amount int8")
            ensure_column(connection, "asn", "ipv6_amount", "ipv6_amount REAL")
            connection.execute(
                "CREATE INDEX IF NOT EXISTS idx_asn_asn ON asn(asn)"
            )
            connection.execute(
                "CREATE INDEX IF NOT EXISTS idx_asn_ipv4_amount ON asn(ipv4_amount)")
            rows = (
                (
                    asn,
                    extract_handle(data),
                    extract_organization(data),
                    format_ip_amount(ip_amount),
                    format_ip_amount(ipv4_amount),
                    format_ipv6_amount_millions(ipv6_amount),
                    json.dumps(data, ensure_ascii=True),
                )
                for asn, data, ip_amount, ipv4_amount, ipv6_amount in entries
            )
            connection.executemany(
                "INSERT INTO asn "
                "(asn, handle, organization, ip_amount, ipv4_amount, ipv6_amount, json) "
                "VALUES (?, ?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(asn) DO UPDATE SET "
                "handle=excluded.handle, "
                "organization=excluded.organization, "
                "ip_amount=excluded.ip_amount, "
                "ipv4_amount=excluded.ipv4_amount, "
                "ipv6_amount=excluded.ipv6_amount, "
                "json=excluded.json",
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

    try:
        entries, skipped = iter_aggregated(as_dir)
    except IntegrityError:
        return 3
    if not entries:
        if skipped:
            print(
                "error: no valid aggregated.json entries found",
                file=sys.stderr,
            )
        else:
            print("error: no aggregated.json files found", file=sys.stderr)
        return 1
    if skipped:
        print(f"warning: skipped {skipped} ASN entries", file=sys.stderr)


    output_path = Path(args.output)
    write_sqlite(entries, output_path)

    print(f"wrote {output_path} ({len(entries)} ASN entries)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
