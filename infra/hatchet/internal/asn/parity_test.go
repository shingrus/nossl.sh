package asn

import (
	"bufio"
	"os"
	"strconv"
	"strings"
	"testing"
)

// TestDumpForParity writes every parsed row as TSV so it can be diffed against
// infra/hatchet/parity/dump_python_asn.py on the same asn-ip checkout:
//
//	PARITY_AS_DIR=/path/to/asn-ip/as PARITY_OUT=/tmp/go.tsv go test ./internal/asn -run TestDumpForParity
func TestDumpForParity(t *testing.T) {
	asDir := os.Getenv("PARITY_AS_DIR")
	outPath := os.Getenv("PARITY_OUT")
	if asDir == "" || outPath == "" {
		t.Skip("set PARITY_AS_DIR and PARITY_OUT to run")
	}
	result, err := ParseDir(asDir, func(string) {})
	if err != nil {
		t.Fatal(err)
	}
	f, err := os.Create(outPath)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	w := bufio.NewWriter(f)
	for _, r := range result.Records {
		fields := []string{
			strconv.FormatInt(r.ASN, 10),
			optional(r.Handle),
			optional(r.Organization),
			optional(r.OrganizationSlug),
			optional(r.Country),
			r.IPAmount,
			r.IPv4Amount,
			r.IPv6Amount,
			r.JSON,
		}
		w.WriteString(strings.Join(fields, "\t") + "\n")
	}
	if err := w.Flush(); err != nil {
		t.Fatal(err)
	}
	t.Logf("records=%d skipped=%d", len(result.Records), result.Skipped)
}
