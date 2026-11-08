// Package mmdb builds the nossl ip2asn and ip2geo MMDB files from ipverse
// data and RFC 8805 geofeeds. The build_mmdb CLI and the Hatchet worker use it.
package mmdb

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/maxmind/mmdbwriter"
	"github.com/maxmind/mmdbwriter/mmdbtype"
)

var errSkipEntry = errors.New("skip entry")

func newWriter(dbType, description string) (*mmdbwriter.Tree, error) {
	return mmdbwriter.New(mmdbwriter.Options{
		DatabaseType:            dbType,
		Description:             map[string]string{"en": description},
		RecordSize:              28,
		IPVersion:               6,
		IncludeReservedNetworks: true,
		DisableIPv4Aliasing:     true,
	})
}

type ingestStats struct {
	entries  int
	prefixes int
	skipped  int
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

func isAlpha(value string) bool {
	for _, r := range value {
		if (r < 'a' || r > 'z') && (r < 'A' || r > 'Z') {
			return false
		}
	}
	return true
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
