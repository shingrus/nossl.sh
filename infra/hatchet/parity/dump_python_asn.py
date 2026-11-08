#!/usr/bin/env python3
"""Dump asn rows exactly as infra/scripts/aggregate_asns.py builds them, as TSV.

Reference side of the Go/Python parity check (see internal/asn/parity_test.go):
    python3 dump_python_asn.py /path/to/asn-ip/as /tmp/python.tsv
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
import aggregate_asns as agg  # noqa: E402


def field(value):
    return "\\N" if value is None else str(value)


def main():
    as_dir, out_path = Path(sys.argv[1]), Path(sys.argv[2])
    entries, skipped = agg.iter_aggregated(as_dir)
    with out_path.open("w", encoding="utf-8") as out:
        for asn, data, ip_amount, ipv4_amount, ipv6_amount in entries:
            organization = agg.extract_organization(data)
            row = [
                str(asn),
                field(agg.extract_handle(data)),
                field(organization),
                field(agg.slugify_organization(organization)),
                field(agg.extract_country(data)),
                field(agg.format_ip_amount(ip_amount)),
                field(agg.format_ip_amount(ipv4_amount)),
                field(agg.format_ipv6_amount_millions(ipv6_amount)),
                json.dumps(data, ensure_ascii=True),
            ]
            out.write("\t".join(row) + "\n")
    print(f"records={len(entries)} skipped={skipped}", file=sys.stderr)


if __name__ == "__main__":
    main()
