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
			addr: addr,
			code: code,
			city: city,
			line: lineNum,
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
	addr netip.Addr
	code string
	city string
	line int
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
