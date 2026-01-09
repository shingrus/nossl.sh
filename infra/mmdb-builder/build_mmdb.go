package main

import (
	"bufio"
	"encoding/csv"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"math/bits"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"reflect"
	"runtime/debug"
	"sort"
	"strconv"
	"strings"

	"github.com/maxmind/mmdbwriter"
	"github.com/maxmind/mmdbwriter/mmdbtype"
	"github.com/oschwald/maxminddb-golang/v2"
	"go4.org/netipx"
)

var errSkipEntry = errors.New("skip entry")

type asnRecord struct {
	asn        int
	name       string
	org        string
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
	geofeedDir := flag.String("geofeed-dir", "", "geofeed directory with RFC 8805 .cache files")
	testMMDB := flag.String("test-mmdb", "", "mmdb path to test against ips.txt and builtin IPs")
	testIP := flag.String("ip", "", "single IP to test with -test-mmdb (overrides ips.txt and builtin IPs)")
	debugMode := flag.Bool("debug", false, "include network (inetnum) in mmdb records")
	flag.Parse()

	asDirSet := false
	countryDirSet := false
	geofeedDirSet := false
	flag.CommandLine.Visit(func(f *flag.Flag) {
		switch f.Name {
		case "as-dir":
			asDirSet = true
		case "country-dir":
			countryDirSet = true
		case "geofeed-dir":
			geofeedDirSet = true
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

	geofeedAvailable := false
	geofeedCacheDir := ""
	if *geofeedDir != "" {
		cacheDir, err := resolveGeofeedCacheDir(*geofeedDir)
		if err != nil {
			fmt.Fprintf(os.Stderr, "error: geofeed directory invalid: %v\n", err)
			os.Exit(2)
		}
		geofeedAvailable = true
		geofeedCacheDir = cacheDir
	} else if geofeedDirSet {
		fmt.Fprintln(os.Stderr, "error: geofeed directory not set")
		os.Exit(2)
	}

	if !asnAvailable && !countryAvailable && !geofeedAvailable && *testMMDB == "" {
		fmt.Fprintln(os.Stderr, "error: no input directories provided")
		os.Exit(2)
	}

	if asnAvailable {
		buildASNMMDB(*asDir, *outPath, *debugMode)
		debug.FreeOSMemory()
	}
	if countryAvailable || geofeedAvailable {
		countryDirPath := ""
		if countryAvailable {
			countryDirPath = *countryDir
		}
		buildCountryMMDB(countryDirPath, geofeedCacheDir, *countryOutPath, *debugMode)
		debug.FreeOSMemory()
	}

	if *testMMDB != "" {
		runMMDBTest(*testMMDB, *testIP)
	} else if *testIP != "" {
		fmt.Fprintln(os.Stderr, "error: -ip requires -test-mmdb")
		os.Exit(2)
	}
}

func buildASNMMDB(asDir, outPath string, debugMode bool) {
	writer, err := newMMDBWriter("ip-to-asn", "IP to ASN")
	if err != nil {
		panic(err)
	}

	stats, err := ingestASNDir(writer, asDir, debugMode)
	if err != nil {
		panic(err)
	}
	if stats.skipped > 0 {
		fmt.Fprintf(os.Stderr, "warning: skipped %d ASN entries\n", stats.skipped)
	}
	if stats.entries == 0 {
		fmt.Fprintln(os.Stderr, "error: no aggregated.json entries found")
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

	fmt.Printf("wrote %s (%d ASN entries, %d prefixes)\n", outPath, stats.entries, stats.prefixes)
}

func buildCountryMMDB(countryDir, geofeedDir, outPath string, debugMode bool) {
	writer, err := newMMDBWriter("ip-to-country", "IP to Country")
	if err != nil {
		panic(err)
	}

	nameIndex := loadCountryNameIndex()
	if geofeedDir != "" && len(nameIndex) == 0 {
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
		fmt.Fprintln(os.Stderr, "error: no country or geofeed entries found")
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

func newMMDBWriter(dbType, description string) (*mmdbwriter.Tree, error) {
	return mmdbwriter.New(mmdbwriter.Options{
		DatabaseType:            dbType,
		Description:             map[string]string{"en": description},
		RecordSize:              28,
		IPVersion:               6,
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

func runMMDBTest(mmdbPath, testIP string) {
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

type ingestStats struct {
	entries  int
	prefixes int
	skipped  int
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

func resolveGeofeedCacheDir(root string) (string, error) {
	info, err := os.Stat(root)
	if err != nil {
		return "", err
	}
	if !info.IsDir() {
		return "", fmt.Errorf("%s is not a directory", root)
	}

	cacheDir := filepath.Join(root, ".cache")
	cacheInfo, err := os.Stat(cacheDir)
	if err == nil {
		if !cacheInfo.IsDir() {
			return "", fmt.Errorf("%s exists but is not a directory", cacheDir)
		}
		return cacheDir, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	return root, nil
}

func ingestGeofeedDir(writer *mmdbwriter.Tree, geofeedDir string, nameIndex map[string]string, debugMode bool) (ingestStats, error) {
	stats := ingestStats{}
	dirEntries, err := os.ReadDir(geofeedDir)
	if err != nil {
		return stats, err
	}

	names := make([]string, 0, len(dirEntries))
	for _, entry := range dirEntries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		if strings.HasPrefix(name, ".") {
			continue
		}
		names = append(names, name)
	}
	sort.Strings(names)

	for _, name := range names {
		filePath := filepath.Join(geofeedDir, name)
		fileStats, err := ingestGeofeedFile(writer, filePath, nameIndex, debugMode)
		if err != nil {
			fmt.Fprintf(os.Stderr, "warning: failed to read %s: %v\n", filePath, err)
			continue
		}
		stats.entries += fileStats.entries
		stats.prefixes += fileStats.prefixes
		stats.skipped += fileStats.skipped
	}

	return stats, nil
}

func ingestGeofeedFile(writer *mmdbwriter.Tree, path string, nameIndex map[string]string, debugMode bool) (ingestStats, error) {
	stats := ingestStats{}
	file, err := os.Open(path)
	if err != nil {
		return stats, err
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	lineNum := 0
	ipRecords := make([]geofeedIPRecord, 0, 1024)
	cidrRecords := make([]geofeedCIDRRecord, 0, 256)
	for scanner.Scan() {
		lineNum++
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}

		prefix, code, city, err := parseGeofeedLine(line)
		if err != nil {
			fmt.Fprintf(os.Stderr, "warning: %s:%d: %v\n", path, lineNum, err)
			stats.skipped++
			continue
		}

		normalizedPrefix, _, err := normalizeCIDRPrefix(prefix, fmt.Sprintf("%s:%d", path, lineNum))
		if err == nil {
			cidrRecords = append(cidrRecords, geofeedCIDRRecord{
				prefix: normalizedPrefix,
				code:   code,
				city:   city,
				line:   lineNum,
			})
			stats.entries++
			continue
		}

		addr, err := netip.ParseAddr(prefix)
		if err != nil {
			fmt.Fprintf(os.Stderr, "warning: %s:%d: invalid prefix %q\n", path, lineNum, prefix)
			stats.skipped++
			continue
		}

		ipRecords = append(ipRecords, geofeedIPRecord{
			addr:   addr,
			code:   code,
			city:   city,
			line:   lineNum,
		})
		stats.entries++
	}
	if err := scanner.Err(); err != nil {
		return stats, err
	}

	for _, record := range cidrRecords {
		_, ipNet, err := net.ParseCIDR(record.prefix)
		if err != nil {
			return stats, fmt.Errorf("bad prefix %q (%s:%d): %w", record.prefix, path, record.line, err)
		}
		if err := insertGeofeedPrefix(writer, ipNet, record.prefix, record.code, record.city, nameIndex, debugMode); err != nil {
			return stats, fmt.Errorf("insert %q (%s:%d): %w", record.prefix, path, record.line, err)
		}
		stats.prefixes++
	}
	cidrRecords = nil

	if len(ipRecords) == 0 {
		return stats, nil
	}

	sort.Slice(ipRecords, func(i, j int) bool {
		if ipRecords[i].addr == ipRecords[j].addr {
			return ipRecords[i].line < ipRecords[j].line
		}
		return ipRecords[i].addr.Compare(ipRecords[j].addr) < 0
	})

	writeIdx := 0
	for i := 0; i < len(ipRecords); {
		last := ipRecords[i]
		j := i + 1
		for j < len(ipRecords) && ipRecords[j].addr == last.addr {
			if ipRecords[j].code != last.code || ipRecords[j].city != last.city {
				fmt.Fprintf(os.Stderr, "warning: %s:%d: conflicting geofeed entry for %s (keeping last)\n", path, ipRecords[j].line, ipRecords[j].addr)
			}
			last = ipRecords[j]
			j++
		}
		ipRecords[writeIdx] = last
		writeIdx++
		i = j
	}
	ipRecords = ipRecords[:writeIdx]

	var pending *geofeedRange
	flushPending := func() error {
		if pending == nil {
			return nil
		}
		prefixCount, err := insertGeofeedRange(writer, *pending, nameIndex, debugMode)
		if err != nil {
			return err
		}
		stats.prefixes += prefixCount
		pending = nil
		return nil
	}

	for _, record := range ipRecords {
		if pending != nil && pending.canAppend(record.addr, record.code, record.city) {
			pending.end = record.addr
			continue
		}
		if err := flushPending(); err != nil {
			return stats, fmt.Errorf("%s: %w", path, err)
		}
		pending = &geofeedRange{
			start: record.addr,
			end:   record.addr,
			code:  record.code,
			city:  record.city,
		}
	}

	if err := flushPending(); err != nil {
		return stats, fmt.Errorf("%s: %w", path, err)
	}
	ipRecords = nil
	return stats, nil
}

type geofeedIPRecord struct {
	addr   netip.Addr
	code   string
	city   string
	line   int
}

type geofeedCIDRRecord struct {
	prefix string
	code   string
	city   string
	line   int
}

type geofeedRange struct {
	start netip.Addr
	end   netip.Addr
	code  string
	city  string
}

func (r *geofeedRange) canAppend(addr netip.Addr, code, city string) bool {
	if r == nil {
		return false
	}
	if r.code != code || r.city != city {
		return false
	}
	if r.start.Is4() != addr.Is4() {
		return false
	}
	next := r.end.Next()
	if !next.IsValid() {
		return false
	}
	return addr == next
}

func insertGeofeedPrefix(
	writer *mmdbwriter.Tree,
	ipNet *net.IPNet,
	prefix, code, city string,
	nameIndex map[string]string,
	debugMode bool,
) error {
	mmdbRecord := mmdbtype.Map{}
	setString(mmdbRecord, "country_code", code)
	setString(mmdbRecord, "country_name", countryNameFromCode(code, nameIndex))
	setString(mmdbRecord, "city_name", city)
	setDebugNetwork(mmdbRecord, prefix, debugMode)
	return writer.Insert(ipNet, mmdbRecord)
}

func insertGeofeedRange(
	writer *mmdbwriter.Tree,
	geofeed geofeedRange,
	nameIndex map[string]string,
	debugMode bool,
) (int, error) {
	ipRange := netipx.IPRangeFrom(geofeed.start, geofeed.end)
	if !ipRange.IsValid() {
		return 0, fmt.Errorf("invalid IP range %s-%s", geofeed.start, geofeed.end)
	}
	prefixes := ipRange.Prefixes()
	if len(prefixes) == 0 {
		return 0, nil
	}

	countryName := countryNameFromCode(geofeed.code, nameIndex)
	for _, prefix := range prefixes {
		ipNet := netipx.PrefixIPNet(prefix)
		mmdbRecord := mmdbtype.Map{}
		setString(mmdbRecord, "country_code", geofeed.code)
		setString(mmdbRecord, "country_name", countryName)
		setString(mmdbRecord, "city_name", geofeed.city)
		setDebugNetwork(mmdbRecord, prefix.String(), debugMode)
		if err := writer.Insert(ipNet, mmdbRecord); err != nil {
			return 0, fmt.Errorf("insert %q: %w", prefix.String(), err)
		}
	}

	return len(prefixes), nil
}

func parseGeofeedLine(line string) (string, string, string, error) {
	reader := csv.NewReader(strings.NewReader(line))
	reader.FieldsPerRecord = -1
	reader.TrimLeadingSpace = true

	record, err := reader.Read()
	if err != nil {
		return "", "", "", fmt.Errorf("invalid CSV: %w", err)
	}
	if len(record) < 2 {
		return "", "", "", fmt.Errorf("expected at least 2 fields")
	}

	rawPrefix := record[0]
	prefix := trimGeofeedField(rawPrefix)
	if prefix == "" {
		return "", "", "", fmt.Errorf("missing prefix %q", rawPrefix)
	}
	rawCode := trimGeofeedField(record[1])
	code := normalizeCountryCode(rawCode)
	if code == "" {
		return "", "", "", fmt.Errorf("invalid country code %q", rawCode)
	}

	city := ""
	if len(record) >= 4 {
		city = trimGeofeedField(record[3])
	}
	return prefix, code, city, nil
}

func trimGeofeedField(value string) string {
	trimmed := strings.TrimSpace(value)
	if len(trimmed) >= 2 {
		if (trimmed[0] == '"' && trimmed[len(trimmed)-1] == '"') ||
			(trimmed[0] == '\'' && trimmed[len(trimmed)-1] == '\'') {
			trimmed = strings.TrimSpace(trimmed[1 : len(trimmed)-1])
		}
	}
	return trimmed
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
	prefixes := []string{}
	_, err := walkNormalizedPrefixes(data, source, func(prefix string) error {
		prefixes = append(prefixes, prefix)
		return nil
	})
	if err != nil {
		return nil, err
	}
	return prefixes, nil
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

func walkNormalizedPrefixes(data map[string]any, source string, fn func(string) error) (int, error) {
	families, err := readPrefixes(data, source)
	if err != nil {
		return 0, err
	}

	count := 0
	for _, family := range []string{"ipv4", "ipv6"} {
		entries, ok := families[family]
		if !ok {
			continue
		}
		for _, entry := range entries {
			if _, ok := normalizePrefix(entry); !ok {
				return 0, skip(source, fmt.Sprintf("invalid %s prefix entry %v", family, entry))
			}
			count++
		}
	}

	if count == 0 {
		return 0, skip(source, "missing prefixes")
	}

	if fn != nil {
		for _, family := range []string{"ipv4", "ipv6"} {
			entries, ok := families[family]
			if !ok {
				continue
			}
			for _, entry := range entries {
				prefix, ok := normalizePrefix(entry)
				if !ok {
					return 0, skip(source, fmt.Sprintf("invalid %s prefix entry %v", family, entry))
				}
				if err := fn(prefix); err != nil {
					return count, err
				}
			}
		}
	}

	return count, nil
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

func normalizeCIDRPrefix(prefix, source string) (string, *net.IPNet, error) {
	addr, mask, err := parseCIDRPrefix(prefix)
	if err != nil {
		return "", nil, err
	}

	pref := netip.PrefixFrom(addr, mask)
	if pref.Masked().Addr() != addr {
		correctedMask := addr.BitLen() - trailingZeroBits(addr)
		if correctedMask > mask {
			fmt.Fprintf(os.Stderr, "warning: %s: prefix %q has host bits set; adjusting mask from /%d to /%d\n", source, prefix, mask, correctedMask)
			mask = correctedMask
		}
	}

	pref = netip.PrefixFrom(addr, mask).Masked()
	return pref.String(), netipx.PrefixIPNet(pref), nil
}

func parseCIDRPrefix(prefix string) (netip.Addr, int, error) {
	parts := strings.SplitN(prefix, "/", 2)
	if len(parts) != 2 {
		return netip.Addr{}, 0, fmt.Errorf("missing CIDR mask")
	}
	addrStr := strings.TrimSpace(parts[0])
	maskStr := strings.TrimSpace(parts[1])
	if addrStr == "" || maskStr == "" {
		return netip.Addr{}, 0, fmt.Errorf("invalid CIDR %q", prefix)
	}

	addr, err := netip.ParseAddr(addrStr)
	if err != nil {
		return netip.Addr{}, 0, err
	}

	mask, err := strconv.Atoi(maskStr)
	if err != nil {
		return netip.Addr{}, 0, fmt.Errorf("invalid prefix length %q", maskStr)
	}
	if mask < 0 || mask > addr.BitLen() {
		return netip.Addr{}, 0, fmt.Errorf("invalid prefix length %d", mask)
	}
	return addr, mask, nil
}

func trailingZeroBits(addr netip.Addr) int {
	if addr.Is4() {
		value := addr.As4()
		return trailingZeroBitsBytes(value[:])
	}
	value := addr.As16()
	return trailingZeroBitsBytes(value[:])
}

func trailingZeroBitsBytes(value []byte) int {
	trailing := 0
	for idx := len(value); idx > 0; idx-- {
		current := value[idx-1]
		if current == 0 {
			trailing += 8
			continue
		}
		trailing += bits.TrailingZeros8(current)
		break
	}
	return trailing
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

func setDebugNetwork(m mmdbtype.Map, network string, debugMode bool) {
	if !debugMode {
		return
	}
	setString(m, "network", network)
}

func fail(source, message string) error {
	return fmt.Errorf("%s: %s", source, message)
}

func skip(source, message string) error {
	return fmt.Errorf("%w: %s: %s", errSkipEntry, source, message)
}
