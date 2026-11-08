package mmdb

// Lookup report for a built MMDB (build_mmdb -test-mmdb).

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"net/netip"
	"os"
	"strings"

	"github.com/oschwald/maxminddb-golang/v2"
)

var builtinTestIPs = []string{
	"1.1.1.1",
	"8.8.8.8",
	"8.8.4.4",
	"9.9.9.9",
	"208.67.222.222",
	"2606:4700:4700::1111",
	"2001:4860:4860::8888",
	"2620:fe::fe",
}

func PrintLookups(mmdbPath, testIP string) {
	reader, err := maxminddb.Open(mmdbPath)
	if err != nil {
		panic(err)
	}
	defer reader.Close()

	fileIPs := []string{}
	if testIP == "" {
		var err error
		fileIPs, err = readIPFile("ips.txt")
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				fmt.Fprintln(os.Stderr, "warning: ips.txt not found; using builtin IPs only")
			} else {
				fmt.Fprintf(os.Stderr, "warning: failed to read ips.txt: %v\n", err)
			}
		}
	}

	ips := []string{}
	if testIP != "" {
		ips = []string{testIP}
	} else {
		ips = mergeUniqueIPs(fileIPs, builtinTestIPs)
	}
	if len(ips) == 0 {
		fmt.Fprintln(os.Stderr, "warning: no IPs to test")
		return
	}

	found := 0
	notFound := 0
	invalid := 0
	lookupErrors := 0
	countryCounts := map[string]int{}

	for _, ipStr := range ips {
		addr, err := netip.ParseAddr(ipStr)
		if err != nil {
			invalid++
			fmt.Printf("%s: invalid IP\n", ipStr)
			continue
		}

		result := reader.Lookup(addr)
		if err := result.Err(); err != nil {
			lookupErrors++
			fmt.Printf("%s: lookup error: %v\n", ipStr, err)
			continue
		}

		if !result.Found() {
			notFound++
			fmt.Printf("%s: not found\n", ipStr)
			continue
		}

		var record map[string]any

		if err := result.Decode(&record); err != nil {
			lookupErrors++
			fmt.Printf("%s: decode error: %v\n", ipStr, err)
			continue
		}

		if code := extractCountryISO(record); code != "" {
			countryCounts[code]++
		}

		found++
		encoded, err := json.Marshal(record)
		if err != nil {
			fmt.Printf("%s: %v\n", ipStr, record)
			continue
		}
		fmt.Printf("%s: %s\n", ipStr, string(encoded))
	}

	total := len(ips)
	valid := total - invalid
	lookups := valid
	fmt.Println("summary:")
	fmt.Printf("  mmdb: %s\n", mmdbPath)
	if testIP != "" {
		fmt.Printf("  total IPs: %d (from flag)\n", total)
	} else {
		fmt.Printf("  total IPs: %d (from file: %d, builtin: %d)\n", total, len(fileIPs), len(builtinTestIPs))
	}
	fmt.Printf("  valid IPs: %d (%.1f%% of total)\n", valid, percent(valid, total))
	fmt.Printf("  invalid IPs: %d (%.1f%% of total)\n", invalid, percent(invalid, total))
	fmt.Printf("  lookups: %d\n", lookups)
	fmt.Printf("  found: %d (%.1f%% of lookups)\n", found, percent(found, lookups))
	fmt.Printf("  not found: %d (%.1f%% of lookups)\n", notFound, percent(notFound, lookups))
	fmt.Printf("  errors: %d (%.1f%% of lookups)\n", lookupErrors, percent(lookupErrors, lookups))

	if len(countryCounts) > 0 {
		fmt.Printf("  country stats: %d\n", len(countryCounts))
		for _, entry := range sortedCountryCounts(countryCounts) {
			fmt.Printf("    %s: %d\n", entry.code, entry.count)
		}
	}
}

func readIPFile(path string) ([]string, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()

	ips := []string{}
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		ips = append(ips, line)
	}
	if err := scanner.Err(); err != nil {
		return ips, err
	}
	return ips, nil
}

func mergeUniqueIPs(primary []string, secondary []string) []string {
	seen := make(map[string]struct{}, len(primary)+len(secondary))
	merged := []string{}
	add := func(values []string) {
		for _, value := range values {
			if value == "" {
				continue
			}
			if _, ok := seen[value]; ok {
				continue
			}
			seen[value] = struct{}{}
			merged = append(merged, value)
		}
	}
	add(primary)
	add(secondary)
	return merged
}

func percent(part, total int) float64 {
	if total == 0 {
		return 0
	}
	return (float64(part) * 100) / float64(total)
}

type countryCount struct {
	code  string
	count int
}

func sortedCountryCounts(counts map[string]int) []countryCount {
	entries := make([]countryCount, 0, len(counts))
	for code, count := range counts {
		entries = append(entries, countryCount{code: code, count: count})
	}
	for i := 0; i < len(entries); i++ {
		for j := i + 1; j < len(entries); j++ {
			if entries[j].count > entries[i].count {
				entries[i], entries[j] = entries[j], entries[i]
				continue
			}
			if entries[j].count == entries[i].count && entries[j].code < entries[i].code {
				entries[i], entries[j] = entries[j], entries[i]
			}
		}
	}
	return entries
}

func extractCountryISO(record map[string]any) string {
	if record == nil {
		return ""
	}
	for _, key := range []string{"country_code", "countryCode", "iso_code"} {
		if code := normalizeCountryCodeFromAny(record[key]); code != "" {
			return code
		}
	}
	if code := normalizeCountryCodeFromAny(record["country"]); code != "" {
		return code
	}
	if code := normalizeCountryCodeFromAny(record["registered_country"]); code != "" {
		return code
	}
	return ""
}
