package mmdb

// Release gate: compare a freshly built ip2geo MMDB with the previous build
// and refuse it when too much IPv4 space changed country or lost coverage.

import (
	"fmt"
	"net/netip"

	"github.com/oschwald/maxminddb-golang/v2"
)

// CompareStats summarises how a new geo MMDB differs from the previous one.
// Sizes are IPv4 address counts; IPv6 is ignored because its space is too
// large and sparse to give a useful share.
type CompareStats struct {
	OldCovered     uint64
	NewCovered     uint64
	ChangedCountry uint64
}

// ChangedShare is the share of the previous build's covered IPv4 space whose
// country differs in the new build.
func (s CompareStats) ChangedShare() float64 {
	if s.OldCovered == 0 {
		return 0
	}
	return float64(s.ChangedCountry) / float64(s.OldCovered)
}

// CoverageDrop is the relative loss of covered IPv4 space (negative when the
// new build covers more).
func (s CompareStats) CoverageDrop() float64 {
	if s.OldCovered == 0 {
		return 0
	}
	return 1 - float64(s.NewCovered)/float64(s.OldCovered)
}

// CompareGeo walks every IPv4 network of both databases. A new network's
// country is compared with the old database's answer for the network's first
// address, so a change is counted at the granularity of the new build.
func CompareGeo(oldPath, newPath string) (CompareStats, error) {
	stats := CompareStats{}

	oldReader, err := maxminddb.Open(oldPath)
	if err != nil {
		return stats, fmt.Errorf("open %s: %w", oldPath, err)
	}
	defer oldReader.Close()

	newReader, err := maxminddb.Open(newPath)
	if err != nil {
		return stats, fmt.Errorf("open %s: %w", newPath, err)
	}
	defer newReader.Close()

	for result := range oldReader.Networks() {
		prefix, code, ok, err := ipv4CountryResult(result)
		if err != nil {
			return stats, fmt.Errorf("%s: %w", oldPath, err)
		}
		if ok && code != "" {
			stats.OldCovered += prefixSize(prefix)
		}
	}

	for result := range newReader.Networks() {
		prefix, newCode, ok, err := ipv4CountryResult(result)
		if err != nil {
			return stats, fmt.Errorf("%s: %w", newPath, err)
		}
		if !ok || newCode == "" {
			continue
		}
		size := prefixSize(prefix)
		stats.NewCovered += size

		var oldRecord map[string]any
		oldResult := oldReader.Lookup(prefix.Addr())
		if err := oldResult.Err(); err != nil {
			return stats, fmt.Errorf("%s lookup %s: %w", oldPath, prefix.Addr(), err)
		}
		if !oldResult.Found() {
			continue
		}
		if err := oldResult.Decode(&oldRecord); err != nil {
			return stats, fmt.Errorf("%s decode %s: %w", oldPath, prefix.Addr(), err)
		}
		oldCode := countryCodeFromRecord(oldRecord)
		if oldCode != "" && oldCode != newCode {
			stats.ChangedCountry += size
		}
	}

	return stats, nil
}

func ipv4CountryResult(result maxminddb.Result) (netip.Prefix, string, bool, error) {
	if err := result.Err(); err != nil {
		return netip.Prefix{}, "", false, err
	}
	prefix := result.Prefix()
	addr := prefix.Addr()
	bits := prefix.Bits()
	if addr.Is4In6() {
		if bits < 96 {
			return netip.Prefix{}, "", false, nil
		}
		addr = addr.Unmap()
		bits -= 96
	}
	if !addr.Is4() {
		return netip.Prefix{}, "", false, nil
	}
	v4Prefix := netip.PrefixFrom(addr, bits).Masked()

	var record map[string]any
	if err := result.Decode(&record); err != nil {
		return netip.Prefix{}, "", false, err
	}
	return v4Prefix, countryCodeFromRecord(record), true, nil
}

func countryCodeFromRecord(record map[string]any) string {
	if record == nil {
		return ""
	}
	if code, ok := record["country_code"].(string); ok {
		return normalizeCountryCode(code)
	}
	return ""
}

func prefixSize(prefix netip.Prefix) uint64 {
	return uint64(1) << uint(32-prefix.Bits())
}
