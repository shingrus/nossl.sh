package mmdb

// RFC 8805 geofeed ingestion and in-place patching of an existing ip2geo MMDB.

import (
	"bufio"
	"encoding/csv"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/maxmind/mmdbwriter"
	"github.com/maxmind/mmdbwriter/mmdbtype"
	"go4.org/netipx"
)

func PatchWithGeofeed(mmdbPath, geofeedPath string, debugMode bool) {
	original, err := os.ReadFile(mmdbPath)
	if err != nil {
		panic(fmt.Errorf("read mmdb %s: %w", mmdbPath, err))
	}

	sourceFile, err := os.CreateTemp("", "mmdb-patch-source-*.mmdb")
	if err != nil {
		panic(err)
	}
	sourcePath := sourceFile.Name()
	defer os.Remove(sourcePath)

	if _, err := sourceFile.Write(original); err != nil {
		sourceFile.Close()
		panic(err)
	}
	if err := sourceFile.Close(); err != nil {
		panic(err)
	}

	writer, err := mmdbwriter.Load(sourcePath, mmdbwriter.Options{
		IncludeReservedNetworks: true,
		DisableIPv4Aliasing:     true,
	})
	if err != nil {
		panic(err)
	}

	nameIndex := loadCountryNameIndex()
	if len(nameIndex) == 0 {
		fmt.Fprintln(os.Stderr, "warning: country name index is empty; geofeed country names will be blank")
	}

	geofeedInfo, err := os.Stat(geofeedPath)
	if err != nil {
		panic(fmt.Errorf("read geofeed path %s: %w", geofeedPath, err))
	}

	patchStats := ingestStats{}
	if geofeedInfo.IsDir() {
		cacheDir, err := ResolveGeofeedCacheDir(geofeedPath)
		if err != nil {
			panic(err)
		}
		patchStats, err = ingestGeofeedDir(writer, cacheDir, nameIndex, debugMode)
		if err != nil {
			panic(err)
		}
	} else {
		patchStats, err = ingestGeofeedFile(writer, geofeedPath, nameIndex, debugMode)
		if err != nil {
			panic(err)
		}
	}

	if patchStats.skipped > 0 {
		fmt.Fprintf(os.Stderr, "warning: skipped %d geofeed entries\n", patchStats.skipped)
	}
	if patchStats.entries == 0 {
		fmt.Fprintln(os.Stderr, "error: no geofeed entries found")
		os.Exit(1)
	}

	tempOut, err := os.CreateTemp(filepath.Dir(mmdbPath), "."+filepath.Base(mmdbPath)+".patch-*")
	if err != nil {
		panic(err)
	}
	tempOutPath := tempOut.Name()
	defer os.Remove(tempOutPath)

	if info, err := os.Stat(mmdbPath); err == nil {
		if err := tempOut.Chmod(info.Mode()); err != nil {
			panic(err)
		}
	}

	if _, err := writer.WriteTo(tempOut); err != nil {
		tempOut.Close()
		panic(err)
	}
	if err := tempOut.Close(); err != nil {
		panic(err)
	}
	if err := os.Rename(tempOutPath, mmdbPath); err != nil {
		panic(err)
	}

	fmt.Printf("patched %s (%d geofeed entries, %d prefixes)\n", mmdbPath, patchStats.entries, patchStats.prefixes)
}

func ResolveGeofeedCacheDir(root string) (string, error) {
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

// Geofeed precedence. mmdbwriter's Insert replaces a network and every subnet
// below it, so insertion order decides which source wins. Entries are first
// collected from every file, then inserted ordered by source tier (lowest
// first) and prefix length (broadest first). Owner-published feeds and more
// specific prefixes therefore always land last and are never erased by a
// broader or weaker row, whatever the file names are.
const (
	geofeedTierDerived = 0 // ASN-level guesses, e.g. the PeeringDB dump
	geofeedTierFeed    = 1 // RFC 8805 feeds published by network owners
)

// derivedGeofeedFilePrefixes names files in the geofeed dir that hold derived
// (non-authoritative) rows rather than an operator's own feed.
var derivedGeofeedFilePrefixes = []string{"pdbdump"}

func geofeedSourceTier(fileName string) int {
	lower := strings.ToLower(fileName)
	for _, prefix := range derivedGeofeedFilePrefixes {
		if strings.HasPrefix(lower, prefix) {
			return geofeedTierDerived
		}
	}
	return geofeedTierFeed
}

type geofeedEntry struct {
	prefix netip.Prefix
	code   string
	city   string
	tier   int
}

// treeBits is the prefix length in the IPv6 tree the writer uses, so IPv4
// and IPv6 entries sort on one scale.
func (e geofeedEntry) treeBits() int {
	if e.prefix.Addr().Is4() {
		return e.prefix.Bits() + 96
	}
	return e.prefix.Bits()
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

	entries := make([]geofeedEntry, 0, 1<<16)
	for _, name := range names {
		filePath := filepath.Join(geofeedDir, name)
		fileEntries, fileStats, err := parseGeofeedFile(filePath, geofeedSourceTier(name))
		if err != nil {
			fmt.Fprintf(os.Stderr, "warning: failed to read %s: %v\n", filePath, err)
			continue
		}
		entries = append(entries, fileEntries...)
		stats.entries += fileStats.entries
		stats.skipped += fileStats.skipped
	}

	prefixes, err := insertGeofeedEntries(writer, entries, nameIndex, debugMode)
	stats.prefixes += prefixes
	return stats, err
}

func ingestGeofeedFile(writer *mmdbwriter.Tree, path string, nameIndex map[string]string, debugMode bool) (ingestStats, error) {
	entries, stats, err := parseGeofeedFile(path, geofeedTierFeed)
	if err != nil {
		return stats, err
	}
	prefixes, err := insertGeofeedEntries(writer, entries, nameIndex, debugMode)
	stats.prefixes += prefixes
	if err != nil {
		return stats, fmt.Errorf("%s: %w", path, err)
	}
	return stats, nil
}

func insertGeofeedEntries(
	writer *mmdbwriter.Tree,
	entries []geofeedEntry,
	nameIndex map[string]string,
	debugMode bool,
) (int, error) {
	sort.SliceStable(entries, func(i, j int) bool {
		if entries[i].tier != entries[j].tier {
			return entries[i].tier < entries[j].tier
		}
		return entries[i].treeBits() < entries[j].treeBits()
	})

	inserted := 0
	for _, entry := range entries {
		prefix := entry.prefix.String()
		if err := insertGeofeedPrefix(writer, netipx.PrefixIPNet(entry.prefix), prefix, entry.code, entry.city, nameIndex, debugMode); err != nil {
			return inserted, fmt.Errorf("insert %q: %w", prefix, err)
		}
		inserted++
	}
	return inserted, nil
}

// parseGeofeedFile reads one RFC 8805 file. CIDR rows are kept as they are;
// single-IP rows are merged into ranges and split back into prefixes.
func parseGeofeedFile(path string, tier int) ([]geofeedEntry, ingestStats, error) {
	stats := ingestStats{}
	file, err := os.Open(path)
	if err != nil {
		return nil, stats, err
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	lineNum := 0
	entries := make([]geofeedEntry, 0, 256)
	ipRecords := make([]geofeedIPRecord, 0, 1024)
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
			parsed, err := netip.ParsePrefix(normalizedPrefix)
			if err != nil {
				return nil, stats, fmt.Errorf("bad prefix %q (%s:%d): %w", normalizedPrefix, path, lineNum, err)
			}
			entries = append(entries, geofeedEntry{prefix: parsed, code: code, city: city, tier: tier})
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
			addr: addr,
			code: code,
			city: city,
			line: lineNum,
		})
		stats.entries++
	}
	if err := scanner.Err(); err != nil {
		return nil, stats, err
	}

	if len(ipRecords) == 0 {
		return entries, stats, nil
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
		ipRange := netipx.IPRangeFrom(pending.start, pending.end)
		if !ipRange.IsValid() {
			return fmt.Errorf("invalid IP range %s-%s", pending.start, pending.end)
		}
		for _, prefix := range ipRange.Prefixes() {
			entries = append(entries, geofeedEntry{prefix: prefix, code: pending.code, city: pending.city, tier: tier})
		}
		pending = nil
		return nil
	}

	for _, record := range ipRecords {
		if pending != nil && pending.canAppend(record.addr, record.code, record.city) {
			pending.end = record.addr
			continue
		}
		if err := flushPending(); err != nil {
			return nil, stats, fmt.Errorf("%s: %w", path, err)
		}
		pending = &geofeedRange{
			start: record.addr,
			end:   record.addr,
			code:  record.code,
			city:  record.city,
		}
	}
	if err := flushPending(); err != nil {
		return nil, stats, fmt.Errorf("%s: %w", path, err)
	}
	return entries, stats, nil
}

type geofeedIPRecord struct {
	addr netip.Addr
	code string
	city string
	line int
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
