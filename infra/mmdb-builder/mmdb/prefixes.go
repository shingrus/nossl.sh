package mmdb

// Prefix normalization shared by the ASN and country inputs.

import (
	"fmt"
	"math/bits"
	"net"
	"net/netip"
	"os"
	"reflect"
	"strconv"
	"strings"

	"go4.org/netipx"
)

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
