package asn

import (
	"encoding/json"
	"testing"
)

// Expected values come from populate_asn_domains.extract_domain_from_rdap.
func TestExtractDomainFromRDAPMatchesPython(t *testing.T) {
	cases := []struct {
		rdap string
		want string
	}{
		{`{"vcardArray": ["vcard", [["version", {}, "text", "4.0"], ["email", {}, "text", "noc@Example.COM."]]]}`, "example.com"},
		{`{"entities": [{"vcardArray": ["vcard", [["email", {}, "text", "mailto:Abuse <abuse@cloudflare.com>"]]]}]}`, "cloudflare.com"},
		{`{"entities": [{"entities": [{"vcardArray": ["vcard", [["email", {}, "text", ["x", "ops@sub.domain.net"]]]]}]}]}`, "sub.domain.net"},
		{`{"vcardArray": ["vcard", [["email", {}, "text", "no-at-sign"]]], "entities": [{"vcardArray": ["vcard", [["email", {}, "text", "a@b.org"]]]}]}`, "b.org"},
		{`{"vcardArray": ["vcard", [["email", {}, "text", "someone@gmail.com"]]]}`, "gmail.com"},
	}
	for _, tc := range cases {
		var data any
		if err := json.Unmarshal([]byte(tc.rdap), &data); err != nil {
			t.Fatal(err)
		}
		if got := extractDomainFromRDAP(data); got != tc.want {
			t.Errorf("extractDomainFromRDAP(%s) = %q, want %q", tc.rdap, got, tc.want)
		}
	}
}
