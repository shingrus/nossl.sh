package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"

	"github.com/maxmind/mmdbwriter"
	"github.com/maxmind/mmdbwriter/mmdbtype"
	"github.com/oschwald/maxminddb-golang/v2"
)

var errSkipEntry = errors.New("skip entry")

type asnRecord struct {
	asn        int
	name       string
	org        string
	domain     string
	country    string
	prefixes   []string
	sourcePath string
}

type countryRecord struct {
	code       string
	name       string
	prefixes   []string
	sourcePath string
}

func main() {
	asDir := flag.String("as-dir", "as", "ASN directory with per-ASN aggregated.json files")
	outPath := flag.String("asn-out", "nossl-sh-ip-to-asn.mmdb", "ASN output mmdb path")
	countryDir := flag.String("country-dir", "", "country directory with per-country aggregated.json files")
	countryOutPath := flag.String("country-out", "nossl-sh-ip-to-country.mmdb", "country output mmdb path")
	testMMDB := flag.String("test-mmdb", "", "mmdb path to test against ips.txt and builtin IPs")
	flag.Parse()

	asDirSet := false
	countryDirSet := false
	flag.CommandLine.Visit(func(f *flag.Flag) {
		switch f.Name {
		case "as-dir":
			asDirSet = true
		case "country-dir":
			countryDirSet = true
		}
	})

	asnAvailable := false
	if *asDir != "" {
		info, err := os.Stat(*asDir)
		if err == nil && info.IsDir() {
			asnAvailable = true
		} else if (countryDirSet && !asDirSet) || (*testMMDB != "" && !asDirSet) {
			fmt.Fprintf(os.Stderr, "warning: ASN directory not found: %s (skipping)\n", *asDir)
		} else {
			fmt.Fprintf(os.Stderr, "error: ASN directory not found: %s\n", *asDir)
			os.Exit(2)
		}
	}

	countryAvailable := false
	if *countryDir != "" {
		info, err := os.Stat(*countryDir)
		if err == nil && info.IsDir() {
			countryAvailable = true
		} else {
			fmt.Fprintf(os.Stderr, "error: country directory not found: %s\n", *countryDir)
			os.Exit(2)
		}
	} else if countryDirSet {
		fmt.Fprintln(os.Stderr, "error: country directory not set")
		os.Exit(2)
	}

	if !asnAvailable && !countryAvailable && *testMMDB == "" {
		fmt.Fprintln(os.Stderr, "error: no input directories provided")
		os.Exit(2)
	}

	if asnAvailable {
		buildASNMMDB(*asDir, *outPath)
	}
	if countryAvailable {
		buildCountryMMDB(*countryDir, *countryOutPath)
	}

	if *testMMDB != "" {
		runMMDBTest(*testMMDB)
	}
}

func buildASNMMDB(asDir, outPath string) {
	writer, err := newMMDBWriter("ip-to-asn", "IP to ASN")
	if err != nil {
		panic(err)
	}

	entries, skipped, err := iterAggregated(asDir)
	if err != nil {
		panic(err)
	}
	if skipped > 0 {
		fmt.Fprintf(os.Stderr, "warning: skipped %d ASN entries\n", skipped)
	}
	if len(entries) == 0 {
		fmt.Fprintln(os.Stderr, "error: no aggregated.json entries found")
		os.Exit(1)
	}

	totalPrefixes := 0
	for _, entry := range entries {
		for _, prefix := range entry.prefixes {
			_, ipNet, err := net.ParseCIDR(prefix)
			if err != nil {
				panic(fmt.Errorf("bad prefix %q (%s): %w", prefix, entry.sourcePath, err))
			}

			record := mmdbtype.Map{}
			setString(record, "asn", strconv.Itoa(entry.asn))
			setString(record, "name", entry.name)
			setString(record, "org", entry.org)
			setString(record, "country_code", entry.country)
			setString(record, "domain", entry.domain)
			setString(record, "network", prefix)

			if err := writer.Insert(ipNet, record); err != nil {
				panic(fmt.Errorf("insert %q (%s): %w", prefix, entry.sourcePath, err))
			}
			totalPrefixes++
		}
	}

	outFile, err := os.Create(outPath)
	if err != nil {
		panic(err)
	}
	defer outFile.Close()

	if _, err := writer.WriteTo(outFile); err != nil {
		panic(err)
	}

	fmt.Printf("wrote %s (%d ASN entries, %d prefixes)\n", outPath, len(entries), totalPrefixes)
}

func buildCountryMMDB(countryDir, outPath string) {
	writer, err := newMMDBWriter("ip-to-country", "IP to Country")
	if err != nil {
		panic(err)
	}

	entries, skipped, err := iterCountryAggregated(countryDir)
	if err != nil {
		panic(err)
	}
	if skipped > 0 {
		fmt.Fprintf(os.Stderr, "warning: skipped %d country entries\n", skipped)
	}
	if len(entries) == 0 {
		fmt.Fprintln(os.Stderr, "error: no aggregated.json entries found")
		os.Exit(1)
	}

	totalPrefixes := 0
	for _, entry := range entries {
		for _, prefix := range entry.prefixes {
			_, ipNet, err := net.ParseCIDR(prefix)
			if err != nil {
				panic(fmt.Errorf("bad prefix %q (%s): %w", prefix, entry.sourcePath, err))
			}

			record := mmdbtype.Map{}
			setString(record, "country_code", entry.code)
			setString(record, "country_name", entry.name)
			setString(record, "network", prefix)

			if err := writer.Insert(ipNet, record); err != nil {
				panic(fmt.Errorf("insert %q (%s): %w", prefix, entry.sourcePath, err))
			}
			totalPrefixes++
		}
	}

	outFile, err := os.Create(outPath)
	if err != nil {
		panic(err)
	}
	defer outFile.Close()

	if _, err := writer.WriteTo(outFile); err != nil {
		panic(err)
	}

	fmt.Printf("wrote %s (%d country entries, %d prefixes)\n", outPath, len(entries), totalPrefixes)
}

func newMMDBWriter(dbType, description string) (*mmdbwriter.Tree, error) {
	return mmdbwriter.New(mmdbwriter.Options{
		DatabaseType:           dbType,
		Description:            map[string]string{"en": description},
		RecordSize:             28,
		IPVersion:              6,
		IncludeReservedNetworks: true,
		DisableIPv4Aliasing:     true,
	})
}

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

func runMMDBTest(mmdbPath string) {
	reader, err := maxminddb.Open(mmdbPath)
	if err != nil {
		panic(err)
	}
	defer reader.Close()

	fileIPs, err := readIPFile("ips.txt")
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			fmt.Fprintln(os.Stderr, "warning: ips.txt not found; using builtin IPs only")
		} else {
			fmt.Fprintf(os.Stderr, "warning: failed to read ips.txt: %v\n", err)
		}
	}

	ips := mergeUniqueIPs(fileIPs, builtinTestIPs)
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
	fmt.Printf("  total IPs: %d (from file: %d, builtin: %d)\n", total, len(fileIPs), len(builtinTestIPs))
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
			domain:     extractDomain(data),
			country:    extractCountry(data),
			prefixes:   prefixes,
			sourcePath: aggPath,
		}
		entries = append(entries, record)
	}

	sortASNRecords(entries)
	return entries, skipped, nil
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

func loadJSON(path string) (map[string]any, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()

	decoder := json.NewDecoder(file)
	decoder.UseNumber()
	var data map[string]any
	if err := decoder.Decode(&data); err != nil {
		return nil, err
	}
	return data, nil
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

func normalizePrefixes(data map[string]any, source string) ([]string, error) {
	families, err := readPrefixes(data, source)
	if err != nil {
		return nil, err
	}

	all := []string{}
	for _, family := range []string{"ipv4", "ipv6"} {
		list, err := normalizeFamilyPrefixes(families, family, source)
		if err != nil {
			return nil, err
		}
		all = append(all, list...)
	}

	if len(all) == 0 {
		return nil, skip(source, "missing prefixes")
	}
	return all, nil
}

func readPrefixes(data map[string]any, source string) (map[string][]any, error) {
	sources := map[string]map[string][]any{}

	collectContainer := func(containerKey string) error {
		raw, ok := data[containerKey]
		if !ok || raw == nil {
			return nil
		}
		container, ok := raw.(map[string]any)
		if !ok {
			return fail(source, fmt.Sprintf("%s is not an object", containerKey))
		}

		families := map[string][]any{}
		for _, fam := range []string{"ipv4", "ipv6"} {
			value, exists := container[fam]
			if !exists {
				continue
			}
			if value == nil {
				families[fam] = []any{}
				continue
			}
			list, ok := value.([]any)
			if !ok {
				return fail(source, fmt.Sprintf("%s.%s is not a list", containerKey, fam))
			}
			families[fam] = list
		}
		if len(families) > 0 {
			sources[containerKey] = families
		}
		return nil
	}

	if err := collectContainer("prefixes"); err != nil {
		return nil, err
	}
	if err := collectContainer("subnets"); err != nil {
		return nil, err
	}

	topLevel := map[string][]any{}
	for _, fam := range []string{"ipv4", "ipv6"} {
		value, exists := data[fam]
		if !exists {
			continue
		}
		if value == nil {
			topLevel[fam] = []any{}
			continue
		}
		list, ok := value.([]any)
		if !ok {
			return nil, fail(source, fmt.Sprintf("%s is not a list", fam))
		}
		topLevel[fam] = list
	}
	if len(topLevel) > 0 {
		sources["top_level"] = topLevel
	}

	if len(sources) == 0 {
		return nil, fail(source, "missing prefixes/subnets/ipv4/ipv6 data")
	}

	if len(sources) > 1 {
		var baseKey string
		var base map[string][]any
		for key, families := range sources {
			baseKey = key
			base = families
			break
		}
		for key, families := range sources {
			if key == baseKey {
				continue
			}
			if !reflect.DeepEqual(families, base) {
				return nil, skip(source, fmt.Sprintf("conflicting prefix sources (%s vs %s); skipping", baseKey, key))
			}
		}
	}

	if families, ok := sources["prefixes"]; ok {
		return families, nil
	}
	if families, ok := sources["subnets"]; ok {
		return families, nil
	}
	if families, ok := sources["top_level"]; ok {
		return families, nil
	}
	return map[string][]any{}, nil
}

func normalizeFamilyPrefixes(families map[string][]any, family string, source string) ([]string, error) {
	entries := families[family]
	normalized := []string{}
	for _, entry := range entries {
		prefix, ok := normalizePrefix(entry)
		if !ok {
			return nil, skip(source, fmt.Sprintf("invalid %s prefix entry %v", family, entry))
		}
		normalized = append(normalized, prefix)
	}
	return normalized, nil
}

func normalizePrefix(prefix any) (string, bool) {
	switch value := prefix.(type) {
	case string:
		trimmed := strings.TrimSpace(value)
		if trimmed == "" {
			return "", false
		}
		return trimmed, true
	case map[string]any:
		for _, key := range []string{"prefix", "cidr", "network", "subnet"} {
			raw, ok := value[key]
			if !ok {
				continue
			}
			trimmed, ok := coerceString(raw)
			if ok {
				return trimmed, true
			}
		}
		return "", false
	default:
		return "", false
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

func coerceString(value any) (string, bool) {
	switch v := value.(type) {
	case string:
		trimmed := strings.TrimSpace(v)
		return trimmed, trimmed != ""
	case json.Number:
		text := strings.TrimSpace(v.String())
		return text, text != ""
	case float64:
		text := strings.TrimSpace(strconv.FormatInt(int64(v), 10))
		return text, text != ""
	case int:
		return strconv.Itoa(v), true
	case int64:
		return strconv.FormatInt(v, 10), true
	default:
		if v == nil {
			return "", false
		}
		text := strings.TrimSpace(fmt.Sprint(v))
		return text, text != ""
	}
}

func isDigits(value string) bool {
	if value == "" {
		return false
	}
	for _, r := range value {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

func normalizeCountryCode(value string) string {
	trimmed := strings.TrimSpace(value)
	if len(trimmed) != 2 || !isAlpha(trimmed) {
		return ""
	}
	return strings.ToUpper(trimmed)
}

func isAlpha(value string) bool {
	for _, r := range value {
		if (r < 'a' || r > 'z') && (r < 'A' || r > 'Z') {
			return false
		}
	}
	return true
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

func sortCountryRecords(entries []countryRecord) {
	for i := 0; i < len(entries); i++ {
		for j := i + 1; j < len(entries); j++ {
			if entries[j].code < entries[i].code {
				entries[i], entries[j] = entries[j], entries[i]
			}
		}
	}
}

func setString(m mmdbtype.Map, key, val string) {
	if val == "" {
		return
	}
	m[mmdbtype.String(key)] = mmdbtype.String(val)
}

func fail(source, message string) error {
	return fmt.Errorf("%s: %s", source, message)
}

func skip(source, message string) error {
	return fmt.Errorf("%w: %s: %s", errSkipEntry, source, message)
}
