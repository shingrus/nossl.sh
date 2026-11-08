package mmdb

// ip2geo: per-country aggregated.json files (plus geofeeds) -> country per prefix.

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/maxmind/mmdbwriter"
	"github.com/maxmind/mmdbwriter/mmdbtype"
)

type countryRecord struct {
	code       string
	name       string
	prefixes   []string
	sourcePath string
}

func BuildCountry(countryDir, geofeedDir, outPath string, debugMode bool) {
	writer, err := newWriter("ip2geo", "IP2GEO")
	if err != nil {
		panic(err)
	}

	nameIndex := loadCountryNameIndex()
	if (geofeedDir != "") && len(nameIndex) == 0 {
		fmt.Fprintln(os.Stderr, "warning: country name index is empty; geofeed country names will be blank")
	}
	stats := ingestStats{}
	if countryDir != "" {
		countryStats, err := ingestCountryDir(writer, countryDir, nameIndex, debugMode)
		if err != nil {
			panic(err)
		}
		if countryStats.skipped > 0 {
			fmt.Fprintf(os.Stderr, "warning: skipped %d country entries\n", countryStats.skipped)
		}
		stats.entries += countryStats.entries
		stats.prefixes += countryStats.prefixes
		stats.skipped += countryStats.skipped
	}
	if geofeedDir != "" {
		geofeedStats, err := ingestGeofeedDir(writer, geofeedDir, nameIndex, debugMode)
		if err != nil {
			panic(err)
		}
		if geofeedStats.skipped > 0 {
			fmt.Fprintf(os.Stderr, "warning: skipped %d geofeed entries\n", geofeedStats.skipped)
		}
		stats.entries += geofeedStats.entries
		stats.prefixes += geofeedStats.prefixes
		stats.skipped += geofeedStats.skipped
	}
	if stats.entries == 0 {
		fmt.Fprintln(os.Stderr, "error: no country, or geofeed entries found")
		os.Exit(1)
	}

	outFile, err := os.Create(outPath)
	if err != nil {
		panic(err)
	}
	defer outFile.Close()

	if _, err := writer.WriteTo(outFile); err != nil {
		panic(err)
	}

	fmt.Printf("wrote %s (%d entries, %d prefixes)\n", outPath, stats.entries, stats.prefixes)
}

func ingestCountryDir(writer *mmdbwriter.Tree, countryDir string, nameIndex map[string]string, debugMode bool) (ingestStats, error) {
	stats := ingestStats{}
	dirEntries, err := os.ReadDir(countryDir)
	if err != nil {
		return stats, err
	}

	names := make([]string, 0, len(dirEntries))
	for _, entry := range dirEntries {
		if entry.IsDir() {
			names = append(names, entry.Name())
		}
	}
	sort.Strings(names)

	for _, dirName := range names {
		aggPath := filepath.Join(countryDir, dirName, "aggregated.json")
		data, err := loadJSON(aggPath)
		if err != nil {
			fmt.Fprintf(os.Stderr, "warning: failed to read %s: %v\n", aggPath, err)
			continue
		}
		if data == nil {
			fmt.Fprintf(os.Stderr, "warning: unexpected JSON in %s\n", aggPath)
			continue
		}

		code := extractCountryCode(data)
		if code == "" {
			fmt.Fprintf(os.Stderr, "warning: %s: missing country code; skipping\n", aggPath)
			stats.skipped++
			continue
		}

		countryName := extractCountryName(data)
		if normalizeCountryCode(countryName) != "" {
			if code == "" {
				code = normalizeCountryCode(countryName)
			}
			countryName = ""
		}

		record := countryRecord{
			code:       code,
			name:       countryName,
			sourcePath: aggPath,
		}
		if record.name != "" && nameIndex != nil {
			nameIndex[record.code] = record.name
		}

		if _, err := walkNormalizedPrefixes(data, aggPath, func(prefix string) error {
			normalizedPrefix, ipNet, err := normalizeCIDRPrefix(prefix, record.sourcePath)
			if err != nil {
				return fmt.Errorf("bad prefix %q (%s): %w", prefix, record.sourcePath, err)
			}

			mmdbRecord := mmdbtype.Map{}
			setString(mmdbRecord, "country_code", record.code)
			setString(mmdbRecord, "country_name", record.name)
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

func loadCountryNameIndex() map[string]string {
	index := map[string]string{}
	candidates := []string{}
	if tzDir := os.Getenv("TZDIR"); tzDir != "" {
		candidates = append(candidates, filepath.Join(tzDir, "iso3166.tab"))
	}
	candidates = append(candidates, "/usr/share/zoneinfo/iso3166.tab", "/usr/share/lib/zoneinfo/iso3166.tab")

	for _, path := range candidates {
		if err := loadISO3166Tab(path, index); err == nil {
			return index
		} else if !errors.Is(err, os.ErrNotExist) {
			fmt.Fprintf(os.Stderr, "warning: failed to read %s: %v\n", path, err)
		}
	}

	return index
}

func loadISO3166Tab(path string, index map[string]string) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		parts := strings.SplitN(line, "\t", 2)
		if len(parts) != 2 {
			continue
		}
		code := normalizeCountryCode(parts[0])
		if code == "" {
			continue
		}
		name := strings.TrimSpace(parts[1])
		if name == "" {
			continue
		}
		index[code] = name
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	return nil
}

func countryNameFromCode(code string, nameIndex map[string]string) string {
	if code == "" || nameIndex == nil {
		return ""
	}
	return nameIndex[code]
}

func normalizeCountryCodeFromAny(value any) string {
	switch v := value.(type) {
	case map[string]any:
		for _, key := range []string{"iso_code", "country_code", "countryCode", "code"} {
			if code := normalizeCountryCodeFromAny(v[key]); code != "" {
				return code
			}
		}
		return ""
	case map[any]any:
		for _, key := range []string{"iso_code", "country_code", "countryCode", "code"} {
			if code := normalizeCountryCodeFromAny(v[key]); code != "" {
				return code
			}
		}
		return ""
	default:
		if text, ok := coerceString(value); ok {
			return normalizeCountryCode(text)
		}
		return ""
	}
}

func iterCountryAggregated(countryDir string) ([]countryRecord, int, error) {
	entries := []countryRecord{}
	skipped := 0
	dirEntries, err := os.ReadDir(countryDir)
	if err != nil {
		return nil, 0, err
	}

	for _, entry := range dirEntries {
		if !entry.IsDir() {
			continue
		}

		aggPath := filepath.Join(countryDir, entry.Name(), "aggregated.json")
		data, err := loadJSON(aggPath)
		if err != nil {
			fmt.Fprintf(os.Stderr, "warning: failed to read %s: %v\n", aggPath, err)
			continue
		}
		if data == nil {
			fmt.Fprintf(os.Stderr, "warning: unexpected JSON in %s\n", aggPath)
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

		code := extractCountryCode(data)
		if code == "" {
			fmt.Fprintf(os.Stderr, "warning: %s: missing country code; skipping\n", aggPath)
			skipped++
			continue
		}

		name := extractCountryName(data)
		if normalizeCountryCode(name) != "" {
			if code == "" {
				code = normalizeCountryCode(name)
			}
			name = ""
		}

		record := countryRecord{
			code:       code,
			name:       name,
			prefixes:   prefixes,
			sourcePath: aggPath,
		}
		entries = append(entries, record)
	}

	sortCountryRecords(entries)
	return entries, skipped, nil
}

func extractCountry(data map[string]any) string {
	for _, key := range []string{"country_code", "countryCode", "country"} {
		if value, ok := coerceString(data[key]); ok {
			return value
		}
	}
	if meta, ok := data["metadata"].(map[string]any); ok {
		for _, key := range []string{"country_code", "countryCode", "country"} {
			if value, ok := coerceString(meta[key]); ok {
				return value
			}
		}
	}
	return ""
}

func extractCountryCode(data map[string]any) string {
	for _, key := range []string{"country_code", "countryCode"} {
		if value, ok := coerceString(data[key]); ok {
			if code := normalizeCountryCode(value); code != "" {
				return code
			}
		}
	}
	if meta, ok := data["metadata"].(map[string]any); ok {
		for _, key := range []string{"country_code", "countryCode"} {
			if value, ok := coerceString(meta[key]); ok {
				if code := normalizeCountryCode(value); code != "" {
					return code
				}
			}
		}
	}
	if value, ok := coerceString(data["country"]); ok {
		if code := normalizeCountryCode(value); code != "" {
			return code
		}
	}
	if meta, ok := data["metadata"].(map[string]any); ok {
		if value, ok := coerceString(meta["country"]); ok {
			if code := normalizeCountryCode(value); code != "" {
				return code
			}
		}
	}
	return ""
}

func extractCountryName(data map[string]any) string {
	for _, key := range []string{"country", "country_name", "countryName", "name"} {
		if value, ok := coerceString(data[key]); ok {
			return value
		}
	}
	if meta, ok := data["metadata"].(map[string]any); ok {
		for _, key := range []string{"country", "country_name", "countryName", "name"} {
			if value, ok := coerceString(meta[key]); ok {
				return value
			}
		}
	}
	return ""
}

func normalizeCountryCode(value string) string {
	trimmed := strings.TrimSpace(value)
	if len(trimmed) != 2 || !isAlpha(trimmed) {
		return ""
	}
	return strings.ToUpper(trimmed)
}

func sortCountryRecords(entries []countryRecord) {
	for i := 0; i < len(entries); i++ {
		for j := i + 1; j < len(entries); j++ {
			if entries[j].code < entries[i].code {
				entries[i], entries[j] = entries[j], entries[i]
			}
		}
	}
}
