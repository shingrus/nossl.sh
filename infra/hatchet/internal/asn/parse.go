// Package asn builds the ASN database: it parses ipverse/asn-ip, stores rows in
// Postgres, fills domains, and exports the SQLite file the website reads.
package asn

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"math/big"
	"math/bits"
	"net/netip"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"nossl.sh/hatchet/internal/pyjson"
)

// Record is one row of the asn table. Field formatting matches what
// aggregate_asns.py wrote, so Go and Python rows compare equal.
type Record struct {
	ASN              int64
	Handle           *string
	Organization     *string
	OrganizationSlug *string
	Country          *string
	IPAmount         string
	IPv4Amount       string
	IPv6Amount       string
	JSON             string
}

// ParseResult is the outcome of parsing an asn-ip "as" directory.
type ParseResult struct {
	Records []Record
	Skipped int
}

// skipEntry drops one ASN (Python SkipEntry); integrityError aborts the run (IntegrityError).
type skipEntry struct{ msg string }

func (e *skipEntry) Error() string { return e.msg }

type integrityError struct{ msg string }

func (e *integrityError) Error() string { return e.msg }

type parser struct {
	source string
	warn   func(string)
}

func (p *parser) skip(format string, args ...any) error {
	return &skipEntry{msg: p.source + ": " + fmt.Sprintf(format, args...)}
}

func (p *parser) fail(format string, args ...any) error {
	return &integrityError{msg: p.source + ": " + fmt.Sprintf(format, args...)}
}

func (p *parser) warnf(format string, args ...any) {
	p.warn(fmt.Sprintf("warning: %s: %s", p.source, fmt.Sprintf(format, args...)))
}

// ParseDir parses every as/<ASN>/aggregated.json under asDir, sorted by ASN.
// warn receives the same warnings aggregate_asns.py printed.
func ParseDir(asDir string, warn func(string)) (ParseResult, error) {
	result := ParseResult{}
	entries, err := os.ReadDir(asDir)
	if err != nil {
		return result, err
	}
	for _, entry := range entries {
		if !entry.IsDir() || !isDigits(entry.Name()) {
			continue
		}
		aggPath := filepath.Join(asDir, entry.Name(), "aggregated.json")
		p := &parser{source: aggPath, warn: warn}
		record, err := p.parseFile(entry.Name())
		var skip *skipEntry
		switch {
		case errors.As(err, &skip):
			warn("warning: " + skip.msg)
			result.Skipped++
		case err != nil:
			return result, err
		case record != nil:
			result.Records = append(result.Records, *record)
		}
	}
	sort.Slice(result.Records, func(i, j int) bool {
		return result.Records[i].ASN < result.Records[j].ASN
	})
	return result, nil
}

// parseFile returns (nil, nil) for files Python ignored without counting them as skipped.
func (p *parser) parseFile(dirName string) (*Record, error) {
	raw, err := os.ReadFile(p.source)
	if errors.Is(err, os.ErrNotExist) {
		p.warn("warning: missing " + p.source)
		return nil, nil
	}
	if err != nil || !utf8.Valid(raw) {
		p.warn(fmt.Sprintf("warning: failed to read %s: %v", p.source, err))
		return nil, nil
	}
	decoded, err := pyjson.Decode(raw)
	if err != nil {
		p.warn(fmt.Sprintf("warning: failed to read %s: %v", p.source, err))
		return nil, nil
	}
	data, ok := decoded.(*pyjson.Object)
	if !ok {
		p.warn("warning: unexpected JSON in " + p.source)
		return nil, nil
	}

	asnValue, present := data.Get("asn")
	if !present {
		asnValue = dirName
	}
	asn, err := pyInt(asnValue)
	if err != nil || asn <= 0 {
		p.warnf("invalid ASN value %s", pyReprShort(asnValue))
		return nil, nil
	}
	if strconv.FormatInt(asn, 10) != dirName {
		return nil, p.skip("ASN mismatch (dir %s, json %s); skipping", dirName, pyReprShort(asnValue))
	}

	normalized, err := p.normalizeRecord(data, asn)
	if err != nil {
		return nil, err
	}
	ipv4, err := p.countAmount(normalized.ipv4, "ipv4")
	if err != nil {
		return nil, err
	}
	ipv6, err := p.countAmount(normalized.ipv6, "ipv6")
	if err != nil {
		return nil, err
	}

	jsonText, err := pyjson.Dumps(normalized.object)
	if err != nil {
		return nil, p.fail("encode: %v", err)
	}
	organization := p.metadataString(normalized.metadata, "description")
	return &Record{
		ASN:              asn,
		Handle:           p.metadataString(normalized.metadata, "handle"),
		Organization:     organization,
		OrganizationSlug: slugifyOrganization(organization),
		Country:          normalized.country,
		IPAmount:         new(big.Int).Add(ipv4, ipv6).String(),
		IPv4Amount:       ipv4.String(),
		IPv6Amount:       formatIPv6Millions(ipv6),
		JSON:             jsonText,
	}, nil
}

type normalizedRecord struct {
	object   *pyjson.Object
	metadata *pyjson.Object
	ipv4     []string
	ipv6     []string
	country  *string
}

func (p *parser) normalizeRecord(data *pyjson.Object, asn int64) (*normalizedRecord, error) {
	metadata, err := p.normalizeMetadata(data)
	if err != nil {
		return nil, err
	}
	ipv4, err := p.normalizePrefixes(data, "ipv4")
	if err != nil {
		return nil, err
	}
	ipv6, err := p.normalizePrefixes(data, "ipv6")
	if err != nil {
		return nil, err
	}

	prefixes := &pyjson.Object{}
	prefixes.Set("ipv4", stringsToAny(ipv4))
	prefixes.Set("ipv6", stringsToAny(ipv6))
	object := &pyjson.Object{}
	object.Set("asn", asn)
	object.Set("metadata", metadata)
	object.Set("prefixes", prefixes)

	country := p.extractCountry(data)
	if country != nil {
		object.Set("country", *country)
	}
	if data.Has("domain") {
		if domain, ok := p.coerceString(data.Value("domain"), "domain"); ok {
			object.Set("domain", domain)
		}
	}
	return &normalizedRecord{object: object, metadata: metadata, ipv4: ipv4, ipv6: ipv6, country: country}, nil
}

func (p *parser) normalizeMetadata(data *pyjson.Object) (*pyjson.Object, error) {
	raw := &pyjson.Object{}
	switch v := data.Value("metadata").(type) {
	case nil:
	case *pyjson.Object:
		raw = v
	default:
		return nil, p.skip("metadata is not an object")
	}
	metadata := raw.Copy()

	if handle, ok := p.firstString(
		[]any{raw.Value("handle"), data.Value("handle")},
		[]string{"metadata.handle", "handle"},
	); ok {
		metadata.Set("handle", handle)
	}
	if description, ok := p.firstString(
		[]any{raw.Value("description"), data.Value("description"), data.Value("organization"), data.Value("Organization")},
		[]string{"metadata.description", "description", "organization", "Organization"},
	); ok {
		metadata.Set("description", description)
	}
	if origin, ok := p.firstString(
		[]any{raw.Value("origin"), data.Value("origin")},
		[]string{"metadata.origin", "origin"},
	); ok {
		metadata.Set("origin", origin)
	}

	filtered := &pyjson.Object{}
	for _, m := range metadata.Members {
		if m.Value != nil {
			filtered.Members = append(filtered.Members, m)
		}
	}
	return filtered, nil
}

// firstString returns the first value that coerces to a non-empty string, like
// Python's chain of `x = coerce_string(...); if x is None: x = coerce_string(...)`.
func (p *parser) firstString(values []any, fields []string) (string, bool) {
	for i, value := range values {
		if s, ok := p.coerceString(value, fields[i]); ok {
			return s, true
		}
	}
	return "", false
}

// coerceString mirrors coerce_string: None -> absent, str -> stripped (empty -> absent),
// anything else -> str(value) with a warning.
func (p *parser) coerceString(value any, field string) (string, bool) {
	switch v := value.(type) {
	case nil:
		return "", false
	case string:
		trimmed := pyStrip(v)
		return trimmed, trimmed != ""
	}
	p.warnf("%s is not a string, coercing", field)
	return p.pyStr(value), true
}

func (p *parser) pyStr(value any) string {
	if s, ok := pyjson.Str(value); ok {
		return s
	}
	// Python would print the container's repr; JSON is the closest stable form.
	p.warnf("container value stringified as JSON; may differ from Python repr")
	s, _ := pyjson.Dumps(value)
	return s
}

func (p *parser) metadataString(metadata *pyjson.Object, key string) *string {
	value, ok := metadata.Get(key)
	if !ok || value == nil {
		return nil
	}
	s := p.pyStr(value)
	return &s
}

// extractCountry mirrors extract_country(data, source) on the raw record.
func (p *parser) extractCountry(data *pyjson.Object) *string {
	keys := []string{"country_code", "countryCode", "country"}
	for _, key := range keys {
		if s, ok := p.coerceString(data.Value(key), key); ok {
			return &s
		}
	}
	if metadata, ok := data.Value("metadata").(*pyjson.Object); ok {
		for _, key := range keys {
			if s, ok := p.coerceString(metadata.Value(key), "metadata."+key); ok {
				return &s
			}
		}
	}
	return nil
}

type prefixFamilies struct {
	keys   []string
	values map[string][]any
}

func (f *prefixFamilies) equal(other *prefixFamilies) bool {
	if len(f.keys) != len(other.keys) {
		return false
	}
	for _, key := range f.keys {
		otherValue, ok := other.values[key]
		if !ok || !pyjson.Equal(f.values[key], otherValue) {
			return false
		}
	}
	return true
}

func (p *parser) collectFamilies(container *pyjson.Object, label string) (*prefixFamilies, error) {
	families := &prefixFamilies{values: map[string][]any{}}
	for _, family := range []string{"ipv4", "ipv6"} {
		value, ok := container.Get(family)
		if !ok {
			continue
		}
		families.keys = append(families.keys, family)
		switch v := value.(type) {
		case nil:
			families.values[family] = []any{}
		case []any:
			families.values[family] = v
		default:
			return nil, p.fail("%s%s is not a list", label, family)
		}
	}
	return families, nil
}

// readPrefixes mirrors read_prefixes: prefixes/subnets containers or top-level lists,
// which must agree when more than one is present.
func (p *parser) readPrefixes(data *pyjson.Object) (*prefixFamilies, error) {
	type source struct {
		name     string
		families *prefixFamilies
	}
	var sources []source
	for _, key := range []string{"prefixes", "subnets"} {
		value, ok := data.Get(key)
		if !ok || value == nil {
			continue
		}
		container, ok := value.(*pyjson.Object)
		if !ok {
			return nil, p.fail("%s is not an object", key)
		}
		families, err := p.collectFamilies(container, key+".")
		if err != nil {
			return nil, err
		}
		if len(families.keys) > 0 {
			sources = append(sources, source{name: key, families: families})
		}
	}
	topLevel, err := p.collectFamilies(data, "")
	if err != nil {
		return nil, err
	}
	if len(topLevel.keys) > 0 {
		sources = append(sources, source{name: "top_level", families: topLevel})
	}

	if len(sources) == 0 {
		return nil, p.fail("missing prefixes/subnets/ipv4/ipv6 data")
	}
	base := sources[0]
	for _, other := range sources[1:] {
		if !other.families.equal(base.families) {
			return nil, p.skip("conflicting prefix sources (%s vs %s); skipping", base.name, other.name)
		}
	}
	return base.families, nil
}

func (p *parser) normalizePrefixes(data *pyjson.Object, family string) ([]string, error) {
	families, err := p.readPrefixes(data)
	if err != nil {
		return nil, err
	}
	normalized := []string{}
	for _, entry := range families.values[family] {
		prefix, ok := normalizePrefix(entry)
		if !ok {
			return nil, p.skip("invalid %s prefix entry %s", family, pyReprShort(entry))
		}
		normalized = append(normalized, prefix)
	}
	return normalized, nil
}

func normalizePrefix(entry any) (string, bool) {
	switch v := entry.(type) {
	case string:
		stripped := pyStrip(v)
		return stripped, stripped != ""
	case *pyjson.Object:
		for _, key := range []string{"prefix", "cidr", "network", "subnet"} {
			if s, ok := v.Value(key).(string); ok {
				stripped := pyStrip(s)
				return stripped, stripped != ""
			}
		}
	}
	return "", false
}

// countAmount sums addresses like ipaddress.ip_network(prefix, strict=False).num_addresses.
func (p *parser) countAmount(prefixes []string, family string) (*big.Int, error) {
	total := new(big.Int)
	for _, prefix := range prefixes {
		hostBits, isV4, err := parseNetwork(prefix)
		if err != nil {
			return nil, p.skip("invalid %s prefix %s: %v", family, pyQuote(prefix), err)
		}
		if family == "ipv4" && !isV4 {
			return nil, p.skip("unexpected ipv6 prefix in ipv4 list: %s", pyQuote(prefix))
		}
		if family == "ipv6" && isV4 {
			return nil, p.skip("unexpected ipv4 prefix in ipv6 list: %s", pyQuote(prefix))
		}
		total.Add(total, new(big.Int).Lsh(big.NewInt(1), uint(hostBits)))
	}
	return total, nil
}

// parseNetwork returns the number of host bits of a network in Python's
// ip_network(..., strict=False) syntax: address, address/len, or IPv4 address/mask.
func parseNetwork(text string) (hostBits int, isV4 bool, err error) {
	addrText, maskText, hasMask := strings.Cut(text, "/")
	if hasMask && strings.Contains(maskText, "/") {
		return 0, false, errors.New("only one '/' permitted")
	}
	addr, err := netip.ParseAddr(addrText)
	if err != nil || addr.Zone() != "" {
		return 0, false, fmt.Errorf("does not appear to be an IPv4 or IPv6 network")
	}
	isV4 = addr.Is4()
	totalBits := addr.BitLen()
	if !hasMask {
		return 0, isV4, nil
	}
	if isASCIIDigits(maskText) {
		length, err := strconv.Atoi(maskText)
		if err != nil || length > totalBits {
			return 0, isV4, fmt.Errorf("%s is not a valid netmask", pyQuote(maskText))
		}
		return totalBits - length, isV4, nil
	}
	if !isV4 {
		return 0, isV4, fmt.Errorf("%s is not a valid netmask", pyQuote(maskText))
	}
	mask, err := netip.ParseAddr(maskText)
	if err != nil || !mask.Is4() {
		return 0, isV4, fmt.Errorf("%s is not a valid netmask", pyQuote(maskText))
	}
	b := mask.As4()
	m := uint32(b[0])<<24 | uint32(b[1])<<16 | uint32(b[2])<<8 | uint32(b[3])
	if ones := bits.LeadingZeros32(^m); m<<ones == 0 {
		return 32 - ones, isV4, nil // netmask: ones then zeros
	}
	if zeros := bits.LeadingZeros32(m); ^m<<zeros == 0 {
		return 32 - zeros, isV4, nil // hostmask: zeros then ones
	}
	return 0, isV4, fmt.Errorf("%s is not a valid netmask", pyQuote(maskText))
}

// formatIPv6Millions mirrors format_ipv6_amount_millions: millions with 2 decimals, half-up.
func formatIPv6Millions(value *big.Int) string {
	million := big.NewInt(1_000_000)
	whole, remainder := new(big.Int).QuoRem(value, million, new(big.Int))
	rounded := new(big.Int).Mul(remainder, big.NewInt(100))
	rounded.Add(rounded, big.NewInt(500_000))
	rounded.Quo(rounded, million)
	if rounded.Cmp(big.NewInt(100)) >= 0 {
		whole.Add(whole, big.NewInt(1))
		rounded.SetInt64(0)
	}
	return fmt.Sprintf("%s.%02d", whole.String(), rounded.Int64())
}

var (
	slugInvalid    = regexp.MustCompile(`[^a-z0-9 ]+`)
	slugWhitespace = regexp.MustCompile(`\s+`)
)

func slugifyOrganization(value *string) *string {
	if value == nil {
		return nil
	}
	text := strings.ToLower(pyStrip(*value))
	if text == "" {
		return nil
	}
	cleaned := slugInvalid.ReplaceAllString(text, "")
	cleaned = strings.TrimSpace(slugWhitespace.ReplaceAllString(cleaned, " "))
	if cleaned == "" {
		return nil
	}
	slug := strings.ReplaceAll(cleaned, " ", "-")
	return &slug
}

// pyInt mirrors Python's int(value) for decoded JSON values.
func pyInt(value any) (int64, error) {
	switch v := value.(type) {
	case string:
		text := strings.ReplaceAll(pyStrip(v), "_", "")
		if strings.HasPrefix(text, "+") {
			text = text[1:]
		}
		return strconv.ParseInt(text, 10, 64)
	case json.Number:
		if pyjson.IsInteger(v) {
			return strconv.ParseInt(string(v), 10, 64)
		}
		f, err := strconv.ParseFloat(string(v), 64)
		if err != nil || math.IsInf(f, 0) || math.IsNaN(f) {
			return 0, errors.New("cannot convert float")
		}
		return int64(f), nil
	case bool:
		if v {
			return 1, nil
		}
		return 0, nil
	}
	return 0, errors.New("unsupported type")
}

// pyStrip strips Python str.isspace() characters, which include 0x1c-0x1f.
func pyStrip(s string) string {
	return strings.TrimFunc(s, func(r rune) bool {
		return unicode.IsSpace(r) || (r >= 0x1c && r <= 0x1f)
	})
}

func pyQuote(s string) string {
	return "'" + s + "'"
}

func pyReprShort(value any) string {
	if s, ok := value.(string); ok {
		return pyQuote(s)
	}
	text, err := pyjson.Dumps(value)
	if err != nil {
		return fmt.Sprintf("%v", value)
	}
	return text
}

func stringsToAny(values []string) []any {
	out := make([]any, len(values))
	for i, v := range values {
		out[i] = v
	}
	return out
}

func isDigits(s string) bool {
	return s != "" && isASCIIDigits(s)
}

func isASCIIDigits(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}
