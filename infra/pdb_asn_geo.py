#!/usr/bin/env python3
"""
pdb_cache_and_asn_geo.py

Downloads PeeringDB datasets and caches them locally, then (optionally) builds an
SQLite table with ASN -> (country, city, dominance) based on PeeringDB presence.

Cache contents (JSONL):
  org, net, fac, ix, netfac, netixlan + manifest.json

Usage:
  export PDB_KEY="..."
  python3 pdb_cache_and_asn_geo.py
  python3 pdb_cache_and_asn_geo.py --cache-dir /tmp/.pdbcache --sleep 1.0
  python3 pdb_cache_and_asn_geo.py --clean --force
  python3 pdb_cache_and_asn_geo.py --asn-db ./asn.sqlite --threshold 0.3

Notes:
- This is NOT prefix/inetnum geolocation. It's "org HQ + ASN presence" inferred from PeeringDB.
- City is chosen only if top city share >= threshold; otherwise city is NULL.
"""

from __future__ import annotations

import argparse
import csv
import json
import logging
import os
import shutil
import sqlite3
import sys
import time
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

import requests

BASE = "https://www.peeringdb.com/api"


# --------------------------
# Logging
# --------------------------
def setup_logger(level: str) -> logging.Logger:
    log = logging.getLogger("pdb")
    log.setLevel(level)
    if not log.handlers:
        h = logging.StreamHandler(sys.stderr)
        h.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
        log.addHandler(h)
    return log


# --------------------------
# HTTP + Pagination
# --------------------------
class PDBClient:
    def __init__(self, api_key: str, sleep_s: float, timeout_s: int, log: logging.Logger):
        self.sleep_s = sleep_s
        self.timeout_s = timeout_s
        self.log = log
        self.s = requests.Session()
        self.s.headers.update(
            {
                "Authorization": f"Api-Key {api_key}",
                "Content-Type": "application/json",
                "User-Agent": "pdb-cache-script/1.1",
            }
        )

    def get(self, path: str, params: Dict[str, Any]) -> Dict[str, Any]:
        url = f"{BASE}{path}"
        SLEEP_429_TIMEOUT = 60
        SLEEP_RETRY_TIMEOUT = 10
        while True:
            self.log.debug("GET %s params=%s", url, params)
            try:
                r = self.s.get(url, params=params, timeout=self.timeout_s)
            except requests.exceptions.RequestException as exc:
                self.log.warning(
                    "Request error (%s), sleeping %ss then retrying",
                    exc.__class__.__name__,
                    SLEEP_RETRY_TIMEOUT,
                )
                time.sleep(SLEEP_RETRY_TIMEOUT)
                continue
            if r.status_code == 429:
                SLEEP_429_TIMEOUT = 60
                self.log.warning(
                    "HTTP 429 rate limit for %s, sleeping %ss then retrying",
                    url,
                    SLEEP_429_TIMEOUT,
                )
                time.sleep(SLEEP_429_TIMEOUT)
                continue
            if r.status_code >= 400:
                raise RuntimeError(f"HTTP {r.status_code}: {r.text[:500]}")
            if self.sleep_s > 0:
                time.sleep(self.sleep_s)
            return r.json()

    def fetch_all(self, obj: str, limit: int = 500, fields: Optional[str] = None) -> Iterable[Dict[str, Any]]:
        """
        PeeringDB uses limit/skip pagination for list endpoints.
        """
        skip = 0
        total = None
        while True:
            params: Dict[str, Any] = {"limit": limit, "skip": skip}
            if fields:
                params["fields"] = fields

            j = self.get(f"/{obj}", params=params)
            data = j.get("data") or []
            meta = j.get("meta") or {}

            total = meta.get("total", total)

            if not data:
                self.log.info("%s: no more data at skip=%s", obj, skip)
                break

            for row in data:
                yield row

            skip += limit

            if isinstance(total, int) and skip >= total:
                self.log.info("%s: reached total=%s", obj, total)
                break


# --------------------------
# Cache I/O
# --------------------------
def default_cache_dir() -> Path:
    return (Path.cwd() / ".pdbcache").resolve()


def cache_paths(cache_dir: Path) -> Dict[str, Path]:
    cache_dir.mkdir(parents=True, exist_ok=True)
    return {
        "dir": cache_dir,
        "org": cache_dir / "org.jsonl",
        "net": cache_dir / "net.jsonl",
        "fac": cache_dir / "fac.jsonl",
        "ix": cache_dir / "ix.jsonl",
        "netfac": cache_dir / "netfac.jsonl",
        "netixlan": cache_dir / "netixlan.jsonl",
        "manifest": cache_dir / "manifest.json",
    }


def write_jsonl(path: Path, rows: Iterable[Dict[str, Any]], log: logging.Logger) -> int:
    tmp = path.with_suffix(path.suffix + ".tmp")
    n = 0
    log.info("Writing %s ...", path.name)
    with tmp.open("w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
            n += 1
            if n % 25_000 == 0:
                log.info("... wrote %s rows to %s", n, path.name)
    tmp.replace(path)
    return n


def read_jsonl(
    path: Path,
    log: Optional[logging.Logger] = None,
    label: Optional[str] = None,
    progress_every: int = 100_000,
) -> Iterable[Dict[str, Any]]:
    if label is None:
        label = path.name
    line_count = 0
    row_count = 0
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line_count += 1
            line = line.strip()
            if not line:
                continue
            row_count += 1
            if log and progress_every > 0 and row_count % progress_every == 0:
                log.info("... loaded %d rows from %s", row_count, label)
            yield json.loads(line)
    if log:
        log.info("Loaded %d rows from %s (%d lines)", row_count, label, line_count)


def clean_cache_dir(cache_dir: Path, log: logging.Logger) -> None:
    if cache_dir.exists():
        log.warning("Cleaning cache dir: %s", cache_dir)
        shutil.rmtree(cache_dir)
    cache_dir.mkdir(parents=True, exist_ok=True)


# --------------------------
# ASN geo build logic
# --------------------------
@dataclass(frozen=True)
class PresencePoint:
    country: Optional[str]
    city: Optional[str]


def norm_city(v: Optional[str]) -> Optional[str]:
    if v is None:
        return None
    s = " ".join(str(v).split()).strip()
    return s or None


def best_from_presence(
    points: List[PresencePoint],
    hq_country: Optional[str],
    threshold: float,
) -> Tuple[Optional[str], Optional[str], float]:
    """
    Returns (best_country, best_city, dominance_share)

    dominance_share: share of top (country,city) among points with city+country known.
    City returned only if dominance_share >= threshold, else None.
    """
    countries = [p.country for p in points if p.country]
    best_country = Counter(countries).most_common(1)[0][0] if countries else hq_country

    city_pairs = [(p.country, p.city) for p in points if p.country and p.city]
    if not city_pairs:
        return best_country, None, 0.0

    c = Counter(city_pairs)
    top_pair, top_count = c.most_common(1)[0]
    total = sum(c.values())
    share = (top_count / total) if total else 0.0

    best_city = top_pair[1] if share >= threshold else None
    return best_country, best_city, share


def build_asn_geo_from_cache(
    cache: Dict[str, Path],
    threshold: float,
    log: logging.Logger,
) -> Dict[int, Tuple[Optional[str], Optional[str], float]]:
    """
    Produces mapping:
      asn -> (country, city, dominance_share)

    Uses:
      net (asn, org_id, id)
      org (hq city/country)
      netfac -> fac -> (city/country)
      netixlan -> ix -> (city/country)
    """
    log.info("Loading cached datasets into memory...")

    # org_id -> (country, city)
    org_loc: Dict[int, Tuple[Optional[str], Optional[str]]] = {}
    log.info("Loading org records...")
    for o in read_jsonl(cache["org"], log=log, label="org"):
        oid = o.get("id")
        if isinstance(oid, int):
            org_loc[oid] = (o.get("country") or None, norm_city(o.get("city")))

    # fac_id -> (country, city)
    fac_loc: Dict[int, Tuple[Optional[str], Optional[str]]] = {}
    log.info("Loading fac records...")
    for f in read_jsonl(cache["fac"], log=log, label="fac"):
        fid = f.get("id")
        if isinstance(fid, int):
            fac_loc[fid] = (f.get("country") or None, norm_city(f.get("city")))

    # ix_id -> (country, city)
    ix_loc: Dict[int, Tuple[Optional[str], Optional[str]]] = {}
    log.info("Loading ix records...")
    for x in read_jsonl(cache["ix"], log=log, label="ix"):
        xid = x.get("id")
        if isinstance(xid, int):
            ix_loc[xid] = (x.get("country") or None, norm_city(x.get("city")))

    # net_id -> (asn, org_id)
    net_info: Dict[int, Tuple[int, int]] = {}
    log.info("Loading net records...")
    for n in read_jsonl(cache["net"], log=log, label="net"):
        nid = n.get("id")
        asn = n.get("asn")
        org_id = n.get("org_id")
        if isinstance(nid, int) and isinstance(asn, int) and isinstance(org_id, int):
            net_info[nid] = (asn, org_id)

    # net_id -> fac_ids
    net_to_fac: Dict[int, List[int]] = defaultdict(list)
    log.info("Loading netfac records...")
    for nf in read_jsonl(cache["netfac"], log=log, label="netfac"):
        nid = nf.get("net_id")
        fid = nf.get("fac_id")
        if isinstance(nid, int) and isinstance(fid, int):
            net_to_fac[nid].append(fid)

    # net_id -> ix_ids
    net_to_ix: Dict[int, List[int]] = defaultdict(list)
    log.info("Loading netixlan records...")
    for nx in read_jsonl(cache["netixlan"], log=log, label="netixlan"):
        nid = nx.get("net_id")
        ixid = nx.get("ix_id")
        if isinstance(nid, int) and isinstance(ixid, int):
            net_to_ix[nid].append(ixid)

    log.info(
        "Loaded: org=%d fac=%d ix=%d net=%d netfac(nets)=%d netixlan(nets)=%d",
        len(org_loc),
        len(fac_loc),
        len(ix_loc),
        len(net_info),
        len(net_to_fac),
        len(net_to_ix),
    )

    # Merge points per ASN
    log.info("Building ASN presence points...")
    asn_points: Dict[int, List[PresencePoint]] = defaultdict(list)
    asn_hq_country: Dict[int, Optional[str]] = {}
    asn_hq_city: Dict[int, Optional[str]] = {}

    net_count = 0
    point_count = 0
    for nid, (asn, org_id) in net_info.items():
        net_count += 1
        hq_country, hq_city = org_loc.get(org_id, (None, None))
        asn_hq_country[asn] = hq_country
        asn_hq_city[asn] = hq_city

        for fid in net_to_fac.get(nid, []):
            c, city = fac_loc.get(fid, (None, None))
            asn_points[asn].append(PresencePoint(country=c, city=city))
            point_count += 1

        for ixid in net_to_ix.get(nid, []):
            c, city = ix_loc.get(ixid, (None, None))
            asn_points[asn].append(PresencePoint(country=c, city=city))
            point_count += 1

        if net_count % 100_000 == 0:
            log.info("... processed %d nets (%d points)", net_count, point_count)

    log.info("Processed %d nets and %d presence points", net_count, point_count)

    log.info("Computing best country/city per ASN...")
    out: Dict[int, Tuple[Optional[str], Optional[str], float]] = {}
    asn_count = 0
    for asn, points in asn_points.items():
        best_country, best_city, share = best_from_presence(
            points, hq_country=asn_hq_country.get(asn), threshold=threshold
        )
        out[asn] = (best_country, best_city, share)
        asn_count += 1
        if asn_count % 100_000 == 0:
            log.info("... computed %d ASNs", asn_count)

    # Include ASNs with net but no presence points
    log.info("Adding ASNs with no presence points...")
    all_asns = {asn for (asn, _org) in net_info.values()}
    for asn in all_asns:
        if asn not in out:
            # Country can still come from HQ; city remains null (HQ isn't presence)
            out[asn] = (asn_hq_country.get(asn), None, 0.0)

    log.info("Computed geo records for %d ASNs", len(out))
    return out


# --------------------------
# SQLite upsert
# --------------------------
def ensure_table(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS asn_geo_pdb (
          asn INTEGER PRIMARY KEY,
          country TEXT,
          city TEXT,
          dominance REAL
        )
        """
    )
    conn.commit()


def upsert_rows(
    conn: sqlite3.Connection,
    rows: Iterable[Tuple[int, Optional[str], Optional[str], float]],
    log: logging.Logger,
) -> None:
    sql = """
      INSERT INTO asn_geo_pdb (asn, country, city, dominance)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(asn) DO UPDATE SET
        country=excluded.country,
        city=excluded.city,
        dominance=excluded.dominance
    """
    batch: List[Tuple[int, Optional[str], Optional[str], float]] = []
    n = 0
    for r in rows:
        batch.append(r)
        if len(batch) >= 10_000:
            conn.executemany(sql, batch)
            conn.commit()
            n += len(batch)
            log.info("Upserted %d rows...", n)
            batch.clear()
    if batch:
        conn.executemany(sql, batch)
        conn.commit()
        n += len(batch)
    log.info("Upsert complete: %d rows", n)


# --------------------------
# Geofeed dump
# --------------------------
def table_exists(conn: sqlite3.Connection, name: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
        (name,),
    ).fetchone()
    return row is not None


def load_asn_json(asn_json: str, log: logging.Logger, asn: int) -> Optional[Dict[str, Any]]:
    try:
        data = json.loads(asn_json)
    except json.JSONDecodeError:
        log.warning("ASN %d: invalid JSON in asn.json", asn)
        return None
    if not isinstance(data, dict):
        log.warning("ASN %d: asn.json is not an object", asn)
        return None
    return data


def extract_asn_country_code(data: Dict[str, Any]) -> Optional[str]:
    def normalize(value: Any) -> Optional[str]:
        if not isinstance(value, str):
            return None
        code = value.strip().upper()
        if len(code) == 2:
            return code
        return None

    code = normalize(data.get("country"))
    if code:
        return code

    metadata = data.get("metadata")
    if isinstance(metadata, dict):
        for key in ("countryCode", "country_code", "country"):
            code = normalize(metadata.get(key))
            if code:
                return code
    return None

def iter_prefixes_from_data(data: Dict[str, Any]) -> Iterable[str]:
    prefixes = data.get("prefixes")
    if isinstance(prefixes, dict):
        for family in ("ipv4", "ipv6"):
            values = prefixes.get(family)
            if isinstance(values, list):
                for entry in values:
                    if isinstance(entry, str):
                        prefix = entry.strip()
                        if prefix:
                            yield prefix
        return

    for family in ("ipv4", "ipv6"):
        values = data.get(family)
        if isinstance(values, list):
            for entry in values:
                if isinstance(entry, str):
                    prefix = entry.strip()
                    if prefix:
                        yield prefix


def dump_geofeed(
    conn: sqlite3.Connection,
    output_path: Path,
    log: logging.Logger,
) -> None:
    for table_name in ("asn", "asn_geo_pdb"):
        if not table_exists(conn, table_name):
            raise RuntimeError(f"Missing table '{table_name}' in SQLite database")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    log.info("Dumping geofeed to %s", output_path)
    cursor = conn.execute(
        """
        SELECT a.asn, a.json, g.country, g.city
        FROM asn a
        JOIN asn_geo_pdb g ON a.asn = g.asn
        WHERE g.country IS NOT NULL AND TRIM(g.country) != ''
        ORDER BY a.asn
        """
    )

    asn_count = 0
    prefix_count = 0
    with output_path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.writer(f)
        for asn, asn_json, country, city in cursor:
            if not asn_json:
                continue
            data = load_asn_json(asn_json, log, asn)
            if data is None:
                continue
            country_code = str(country).strip().upper()
            if not country_code:
                continue
            asn_country = extract_asn_country_code(data)
            if not asn_country:
                log.debug("ASN %d: missing country code in asn.json; skipping geofeed rows", asn)
                continue
            if asn_country != country_code:
                log.debug(
                    "ASN %d: asn.json country %s != pdb country %s; skipping geofeed rows",
                    asn,
                    asn_country,
                    country_code,
                )
                continue
            city_name = str(city).strip() if city else ""
            wrote = False
            for prefix in iter_prefixes_from_data(data):
                writer.writerow([prefix, country_code, "", city_name])
                prefix_count += 1
                wrote = True
            if wrote:
                asn_count += 1

    log.info("Geofeed dump complete: %d ASNs, %d prefixes", asn_count, prefix_count)


# --------------------------
# Main
# --------------------------
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--cache-dir",
        default=None,
        help="Cache directory (default: .pdbcache subdir of current working dir)",
    )
    ap.add_argument("--clean", action="store_true", help="Start from a clean cache dir (delete and recreate)")
    ap.add_argument("--sleep", type=float, default=1, help="Sleep between PeeringDB requests (default 0.5s)")
    ap.add_argument("--asn-db", default=None, help="Path to SQLite ASN DB; if set, upsert into asn_geo_pdb table")
    ap.add_argument(
        "--dump-geofeed",
        default=None,
        help="Write geofeed CSV to file (requires --asn-db)",
    )
    ap.add_argument("--threshold", type=float, default=0.3, help="City dominance threshold (default 0.3)")
    ap.add_argument("--limit", type=int, default=250, help="Pagination limit per request (default 250)")
    ap.add_argument("--timeout", type=int, default=25, help="HTTP timeout seconds (default 25)")
    ap.add_argument("--force", action="store_true", help="Redownload even if cache files exist")
    ap.add_argument("--log-level", default="INFO", choices=["DEBUG", "INFO", "WARNING", "ERROR"])
    ap.add_argument("--api-key", default=None, help="PeeringDB API key (or use env PDB_KEY)")
    args = ap.parse_args()

    log = setup_logger(args.log_level)
    log.info("Starting PeeringDB cache build")

    if args.dump_geofeed and not args.asn_db:
        log.error("--dump-geofeed requires --asn-db")
        return 1

    api_key = args.api_key or os.getenv("PDB_KEY")
    if not api_key:
        log.error("Missing API key: provide --api-key or set env PDB_KEY")
        return 1

    cache_dir = Path(args.cache_dir).expanduser().resolve() if args.cache_dir else default_cache_dir()
    log.info("Cache dir: %s", cache_dir)

    if args.clean:
        clean_cache_dir(cache_dir, log)
    else:
        cache_dir.mkdir(parents=True, exist_ok=True)

    cache = cache_paths(cache_dir)
    log.info("Cache paths ready")

    client = PDBClient(api_key=api_key, sleep_s=args.sleep, timeout_s=args.timeout, log=log)

    datasets = [
        ("org", "id,city,country"),
        ("net", "id,asn,org_id"),
        ("fac", "id,city,country"),
        ("ix", "id,city,country"),
        ("netfac", "id,net_id,fac_id"),
        ("netixlan", "id,net_id,ix_id"),
    ]
    log.info("Datasets: %s", ", ".join(obj for obj, _fields in datasets))

    manifest: Dict[str, Any] = {
        "base": BASE,
        "downloaded_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "sleep": args.sleep,
        "limit": args.limit,
        "cache_dir": str(cache_dir),
        "datasets": {},
    }

    for idx, (obj, fields) in enumerate(datasets, start=1):
        out_path = cache[obj]
        if out_path.exists() and not args.force:
            log.info("[%d/%d] Cache exists, skipping: %s (%s)", idx, len(datasets), obj, out_path)
            manifest["datasets"][obj] = {"cached": True, "rows": None, "path": str(out_path)}
            continue

        log.info("[%d/%d] Downloading %s ...", idx, len(datasets), obj)
        rows_iter = client.fetch_all(obj, limit=args.limit, fields=fields)
        count = write_jsonl(out_path, rows_iter, log)
        log.info("Saved %s rows to %s", count, out_path)
        manifest["datasets"][obj] = {"cached": False, "rows": count, "path": str(out_path)}

    log.info("Writing manifest...")
    cache["manifest"].write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    log.info("Wrote manifest: %s", cache["manifest"])

    if args.asn_db:
        db_path = Path(args.asn_db).expanduser().resolve()
        log.info("Opening SQLite DB: %s", db_path)
        conn = sqlite3.connect(str(db_path))
        try:
            log.info("Ensuring asn_geo_pdb table exists")
            ensure_table(conn)
            log.info("Building ASN geo map from cached files (threshold=%.3f)...", args.threshold)

            # Ensure required cache files exist
            required = ["org", "net", "fac", "ix", "netfac", "netixlan"]
            missing = [k for k in required if not cache[k].exists()]
            if missing:
                raise RuntimeError(f"Missing cache files: {missing}. Run download first (or without --asn-db).")

            geo = build_asn_geo_from_cache(cache, threshold=args.threshold, log=log)
            log.info("Upserting ASN geo rows into SQLite...")

            rows = ((asn, country, city, float(dom)) for asn, (country, city, dom) in geo.items())
            upsert_rows(conn, rows, log)

            if args.dump_geofeed:
                dump_path = Path(args.dump_geofeed).expanduser().resolve()
                dump_geofeed(conn, dump_path, log)
        finally:
            conn.close()
            log.info("SQLite closed")

    log.info("Done.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
