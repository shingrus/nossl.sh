package mmdb

// ip2asn: per-ASN aggregated.json files -> ASN, name, org, country per prefix.

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/maxmind/mmdbwriter"
	"github.com/maxmind/mmdbwriter/mmdbtype"
)

type asnRecord struct {
	asn        int
	name       string
	org        string
	country    string
	prefixes   []string
	sourcePath string
}

// ASNStats summarizes an ASN MMDB build.
type ASNStats struct {
	Entries  int
	Prefixes int
	Skipped  int
}

// BuildASN builds the ip2asn MMDB from per-ASN aggregated.json files in asDir.
func BuildASN(asDir, outPath string, debugMode bool) (ASNStats, error) {
	writer, err := newWriter("ip2asn", "IP2ASN")
	if err != nil {
		return ASNStats{}, err
	}

	stats, err := ingestASNDir(writer, asDir, debugMode)
	result := ASNStats{Entries: stats.entries, Prefixes: stats.prefixes, Skipped: stats.skipped}
	if err != nil {
		return result, err
	}
	if stats.entries == 0 {
		return result, errors.New("no aggregated.json entries found")
	}

	outFile, err := os.Create(outPath)
	if err != nil {
		return result, err
	}
	if _, err := writer.WriteTo(outFile); err != nil {
		outFile.Close()
		return result, err
	}
	return result, outFile.Close()
}

type asnDirEntry struct {
	name string
	asn  int
}

func ingestASNDir(writer *mmdbwriter.Tree, asDir string, debugMode bool) (ingestStats, error) {
	stats := ingestStats{}
	dirEntries, err := os.ReadDir(asDir)
	if err != nil {
		return stats, err
	}

	asnEntries := make([]asnDirEntry, 0, len(dirEntries))
	for _, entry := range dirEntries {
		if !entry.IsDir() {
			continue
		}
		name := entry.Name()
		if !isDigits(name) {
			continue
		}
		asn, err := strconv.Atoi(name)
		if err != nil || asn <= 0 {
			continue
		}
		asnEntries = append(asnEntries, asnDirEntry{name: name, asn: asn})
	}

	sort.Slice(asnEntries, func(i, j int) bool {
		return asnEntries[i].asn < asnEntries[j].asn
	})

	for _, entry := range asnEntries {
		aggPath := filepath.Join(asDir, entry.name, "aggregated.json")
		data, err := loadJSON(aggPath)
		if err != nil {
			fmt.Fprintf(os.Stderr, "warning: failed to read %s: %v\n", aggPath, err)
			continue
		}
		if data == nil {
			fmt.Fprintf(os.Stderr, "warning: unexpected JSON in %s\n", aggPath)
			continue
		}

		asn, err := parseASN(data["asn"], entry.name)
		if err != nil || asn <= 0 {
			fmt.Fprintf(os.Stderr, "warning: %s: invalid ASN value\n", aggPath)
			continue
		}
		if asn != entry.asn {
			fmt.Fprintf(os.Stderr, "warning: %s: ASN mismatch (dir %s, json %d); skipping\n", aggPath, entry.name, asn)
			stats.skipped++
			continue
		}

		handle := extractHandle(data)
		org := extractOrganization(data)
		name := handle
		if name == "" {
			name = org
		}

		record := asnRecord{
			asn:        asn,
			name:       name,
			org:        org,
			country:    extractCountry(data),
			sourcePath: aggPath,
		}

		if _, err := walkNormalizedPrefixes(data, aggPath, func(prefix string) error {
			normalizedPrefix, ipNet, err := normalizeCIDRPrefix(prefix, record.sourcePath)
			if err != nil {
				return fmt.Errorf("bad prefix %q (%s): %w", prefix, record.sourcePath, err)
			}

			mmdbRecord := mmdbtype.Map{}
			setString(mmdbRecord, "asn", strconv.Itoa(record.asn))
			setString(mmdbRecord, "name", record.name)
			setString(mmdbRecord, "org", record.org)
			setString(mmdbRecord, "country_code", record.country)
			setDebugNetwork(mmdbRecord, normalizedPrefix, debugMode)

			if err := writer.Insert(ipNet, mmdbRecord); err != nil {
				return fmt.Errorf("insert %q (%s): %w", normalizedPrefix, record.sourcePath, err)
			}
			stats.prefixes++
			return nil
		}); err != nil {
			if errors.Is(err, errSkipEntry) {
				fmt.Fprintf(os.Stderr, "warning: %s\n", err)
				stats.skipped++
				continue
			}
			return stats, err
		}
		stats.entries++

		data = nil
	}

	return stats, nil
}

func iterAggregated(asDir string) ([]asnRecord, int, error) {
	entries := []asnRecord{}
	skipped := 0
	dirEntries, err := os.ReadDir(asDir)
	if err != nil {
		return nil, 0, err
	}

	for _, entry := range dirEntries {
		if !entry.IsDir() {
			continue
		}
		if !isDigits(entry.Name()) {
			continue
		}

		aggPath := filepath.Join(asDir, entry.Name(), "aggregated.json")
		data, err := loadJSON(aggPath)
		if err != nil {
			fmt.Fprintf(os.Stderr, "warning: failed to read %s: %v\n", aggPath, err)
			continue
		}
		if data == nil {
			fmt.Fprintf(os.Stderr, "warning: unexpected JSON in %s\n", aggPath)
			continue
		}

		asn, err := parseASN(data["asn"], entry.Name())
		if err != nil || asn <= 0 {
			fmt.Fprintf(os.Stderr, "warning: %s: invalid ASN value\n", aggPath)
			continue
		}
		if strconv.Itoa(asn) != entry.Name() {
			fmt.Fprintf(os.Stderr, "warning: %s: ASN mismatch (dir %s, json %d); skipping\n", aggPath, entry.Name(), asn)
			skipped++
			continue
		}

		prefixes, err := normalizePrefixes(data, aggPath)
		if err != nil {
			if errors.Is(err, errSkipEntry) {
				fmt.Fprintf(os.Stderr, "warning: %s\n", err)
				skipped++
				continue
			}
			return nil, skipped, err
		}

		handle := extractHandle(data)
		org := extractOrganization(data)
		name := handle
		if name == "" {
			name = org
		}

		record := asnRecord{
			asn:        asn,
			name:       name,
			org:        org,
			country:    extractCountry(data),
			prefixes:   prefixes,
			sourcePath: aggPath,
		}
		entries = append(entries, record)
	}

	sortASNRecords(entries)
	return entries, skipped, nil
}

func parseASN(value any, fallback string) (int, error) {
	if value == nil {
		return strconv.Atoi(fallback)
	}
	switch v := value.(type) {
	case json.Number:
		asn, err := v.Int64()
		return int(asn), err
	case float64:
		return int(v), nil
	case string:
		return strconv.Atoi(strings.TrimSpace(v))
	default:
		return 0, fmt.Errorf("unsupported ASN type %T", value)
	}
}

func extractHandle(data map[string]any) string {
	if meta, ok := data["metadata"].(map[string]any); ok {
		if value, ok := coerceString(meta["handle"]); ok {
			return value
		}
	}
	if value, ok := coerceString(data["handle"]); ok {
		return value
	}
	return ""
}

func extractOrganization(data map[string]any) string {
	if meta, ok := data["metadata"].(map[string]any); ok {
		if value, ok := coerceString(meta["description"]); ok {
			return value
		}
	}
	for _, key := range []string{"organization", "Organization", "description"} {
		if value, ok := coerceString(data[key]); ok {
			return value
		}
	}
	return ""
}

func extractDomain(data map[string]any) string {
	if value, ok := coerceString(data["domain"]); ok {
		return value
	}
	return ""
}

func sortASNRecords(entries []asnRecord) {
	for i := 0; i < len(entries); i++ {
		for j := i + 1; j < len(entries); j++ {
			if entries[j].asn < entries[i].asn {
				entries[i], entries[j] = entries[j], entries[i]
			}
		}
	}
}
