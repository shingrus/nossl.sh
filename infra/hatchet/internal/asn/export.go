package asn

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"sort"

	_ "modernc.org/sqlite"
)

// exportSchema is the layout aggregate_asns.py, populate_asn_domains.py, and
// pdb_asn_geo.py produced; componets/asn-info.js queries it as-is.
var exportSchema = []string{
	`CREATE TABLE asn (asn INTEGER PRIMARY KEY, handle TEXT, organization TEXT, organization_slug TEXT, country TEXT, ip_amount int8, ipv4_amount int8, ipv6_amount REAL, json TEXT NOT NULL)`,
	`CREATE INDEX idx_asn_asn ON asn(asn)`,
	`CREATE INDEX idx_asn_ipv4_amount ON asn(ipv4_amount)`,
	`CREATE INDEX idx_asn_ipv6_amount ON asn(ipv6_amount)`,
	`CREATE INDEX idx_asn_org_trim ON asn(TRIM(organization))`,
	`CREATE INDEX idx_asn_org_slug ON asn(organization_slug)`,
	`CREATE INDEX idx_asn_country_trim ON asn(TRIM(country))`,
	`CREATE TABLE asn_domain (asn INTEGER PRIMARY KEY, domain TEXT)`,
	`CREATE TABLE asn_geo_pdb (asn INTEGER PRIMARY KEY, country TEXT, city TEXT, dominance REAL, domain TEXT)`,
}

// ExportStats counts exported rows.
type ExportStats struct {
	ASNs    int `json:"asns"`
	Domains int `json:"domains"`
	GeoPDB  int `json:"geo_pdb"`
}

// ExportSQLite writes a fresh asn.sqlite3 at path from Postgres-backed data:
// the parsed records plus stale rows, every asn_domain row, and asn_geo_pdb.
func ExportSQLite(ctx context.Context, path string, records []Record, domains []DomainRow, geo []GeoPDBRow) (ExportStats, error) {
	stats := ExportStats{}
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return stats, err
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return stats, err
	}
	defer db.Close()
	db.SetMaxOpenConns(1)

	for _, pragma := range []string{"PRAGMA journal_mode=OFF", "PRAGMA synchronous=OFF"} {
		if _, err := db.ExecContext(ctx, pragma); err != nil {
			return stats, err
		}
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return stats, err
	}
	defer tx.Rollback()
	for _, stmt := range exportSchema {
		if _, err := tx.ExecContext(ctx, stmt); err != nil {
			return stats, fmt.Errorf("create schema: %w", err)
		}
	}

	sorted := append([]Record(nil), records...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].ASN < sorted[j].ASN })
	// Amounts are bound as text, as Python did, so SQLite applies the same column affinity.
	asnStmt, err := tx.PrepareContext(ctx, `INSERT INTO asn
		(asn, handle, organization, organization_slug, country, ip_amount, ipv4_amount, ipv6_amount, json)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
	if err != nil {
		return stats, err
	}
	for _, r := range sorted {
		if _, err := asnStmt.ExecContext(ctx, r.ASN, r.Handle, r.Organization, r.OrganizationSlug, r.Country,
			textOrNull(r.IPAmount), textOrNull(r.IPv4Amount), textOrNull(r.IPv6Amount), r.JSON); err != nil {
			return stats, fmt.Errorf("insert AS%d: %w", r.ASN, err)
		}
		stats.ASNs++
	}

	domainStmt, err := tx.PrepareContext(ctx, `INSERT INTO asn_domain (asn, domain) VALUES (?, ?)`)
	if err != nil {
		return stats, err
	}
	for _, d := range domains {
		if _, err := domainStmt.ExecContext(ctx, d.ASN, d.Domain); err != nil {
			return stats, fmt.Errorf("insert domain AS%d: %w", d.ASN, err)
		}
		stats.Domains++
	}

	geoStmt, err := tx.PrepareContext(ctx, `INSERT INTO asn_geo_pdb (asn, country, city, dominance, domain) VALUES (?, ?, ?, ?, ?)`)
	if err != nil {
		return stats, err
	}
	for _, g := range geo {
		if _, err := geoStmt.ExecContext(ctx, g.ASN, g.Country, g.City, g.Dominance, g.Domain); err != nil {
			return stats, fmt.Errorf("insert geo AS%d: %w", g.ASN, err)
		}
		stats.GeoPDB++
	}
	if err := tx.Commit(); err != nil {
		return stats, err
	}
	return stats, nil
}

func textOrNull(s string) any {
	if s == "" {
		return nil
	}
	return s
}
