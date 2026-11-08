package asn

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/mail"
	"strings"
	"time"

	"golang.org/x/net/idna"
)

// NoDomain is stored when a lookup succeeded but found nothing, so the ASN is
// not looked up again (the convention populate_asn_domains.py used).
const NoDomain = " "

// DomainOptions mirror populate_asn_domains.py defaults.
type DomainOptions struct {
	RDAPBaseURL    string
	UserAgent      string
	Timeout        time.Duration
	Delay          time.Duration
	RateLimitSleep time.Duration
}

func DefaultDomainOptions() DomainOptions {
	return DomainOptions{
		RDAPBaseURL:    "https://rdap.arin.net/registry/autnum/",
		UserAgent:      "asn-ip-domain-loader/1.0",
		Timeout:        20 * time.Second,
		Delay:          200 * time.Millisecond,
		RateLimitSleep: 15 * time.Second,
	}
}

// DomainStats counts the outcome of a domain fill.
type DomainStats struct {
	Pending   int `json:"pending"`
	FromPDB   int `json:"from_pdb"`
	FromRDAP  int `json:"from_rdap"`
	NotFound  int `json:"not_found"`
	Failed    int `json:"failed"`
	Processed int `json:"processed"`
}

// FillDomains looks up domains for ASNs that have none, writing each result
// as soon as it is known. Failed lookups are left pending for the next run.
func FillDomains(ctx context.Context, store *Store, opts DomainOptions, progress func(string)) (DomainStats, error) {
	stats := DomainStats{}
	pending, err := store.PendingDomainASNs(ctx)
	if err != nil {
		return stats, fmt.Errorf("list pending domains: %w", err)
	}
	pdbDomains, err := store.PDBDomains(ctx)
	if err != nil {
		return stats, fmt.Errorf("read PeeringDB domains: %w", err)
	}
	stats.Pending = len(pending)
	progress(fmt.Sprintf("domains: %d ASNs pending, %d PeeringDB domains available", len(pending), len(pdbDomains)))

	client := &http.Client{Timeout: opts.Timeout}
	lastReport := time.Now()
	for i, asn := range pending {
		if err := ctx.Err(); err != nil {
			return stats, err
		}
		domain := ""
		if raw, ok := pdbDomains[asn]; ok {
			domain = normalizeDomain(raw)
			if domain != "" {
				stats.FromPDB++
			}
		}
		if domain == "" {
			found, ok := lookupRDAPDomain(ctx, client, opts, asn, progress)
			switch {
			case !ok:
				stats.Failed++
			case found == NoDomain:
				stats.NotFound++
			default:
				stats.FromRDAP++
			}
			domain = found
			if err := sleep(ctx, opts.Delay); err != nil {
				return stats, err
			}
		}
		if domain != "" {
			if err := store.UpsertDomain(ctx, asn, domain); err != nil {
				return stats, fmt.Errorf("store domain for AS%d: %w", asn, err)
			}
		}
		stats.Processed = i + 1
		if time.Since(lastReport) >= 30*time.Second {
			progress(fmt.Sprintf("domains: %d/%d (pdb=%d rdap=%d not_found=%d failed=%d)",
				stats.Processed, stats.Pending, stats.FromPDB, stats.FromRDAP, stats.NotFound, stats.Failed))
			lastReport = time.Now()
		}
	}
	return stats, nil
}

// lookupRDAPDomain returns (domain, true), (NoDomain, true), or ("", false) on a
// transient failure, matching rdap_lookup_domain.
func lookupRDAPDomain(ctx context.Context, client *http.Client, opts DomainOptions, asn int64, progress func(string)) (string, bool) {
	url := fmt.Sprintf("%s%d", opts.RDAPBaseURL, asn)
	for {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			return "", false
		}
		req.Header.Set("User-Agent", opts.UserAgent)
		req.Header.Set("Accept", "application/rdap+json")
		resp, err := client.Do(req)
		if err != nil {
			return "", false
		}
		switch {
		case resp.StatusCode == http.StatusTooManyRequests:
			resp.Body.Close()
			progress(fmt.Sprintf("domains: RDAP rate limit hit; sleeping %s", opts.RateLimitSleep))
			if err := sleep(ctx, opts.RateLimitSleep); err != nil {
				return "", false
			}
			continue
		case resp.StatusCode == http.StatusForbidden || resp.StatusCode == http.StatusNotFound:
			resp.Body.Close()
			return NoDomain, true
		case resp.StatusCode < 200 || resp.StatusCode > 299:
			resp.Body.Close()
			return "", false
		}
		var data any
		err = json.NewDecoder(resp.Body).Decode(&data)
		resp.Body.Close()
		if err != nil {
			return "", false
		}
		domain := extractDomainFromRDAP(data)
		if domain == "" || domain == "gmail.com" {
			return NoDomain, true
		}
		return domain, true
	}
}

// extractDomainFromRDAP walks the RDAP response breadth-first for vCard emails.
func extractDomainFromRDAP(data any) string {
	queue := []any{data}
	for len(queue) > 0 {
		current, ok := queue[0].(map[string]any)
		queue = queue[1:]
		if !ok {
			continue
		}
		if vcard, ok := current["vcardArray"].([]any); ok && len(vcard) > 1 {
			if entries, ok := vcard[1].([]any); ok {
				if domain := domainFromVCard(entries); domain != "" {
					return domain
				}
			}
		}
		if entities, ok := current["entities"].([]any); ok {
			queue = append(queue, entities...)
		}
	}
	return ""
}

func domainFromVCard(entries []any) string {
	for _, e := range entries {
		entry, ok := e.([]any)
		if !ok || len(entry) < 4 || entry[0] != "email" {
			continue
		}
		switch value := entry[3].(type) {
		case []any:
			for _, item := range value {
				if s, ok := item.(string); ok {
					if domain := domainFromEmail(s); domain != "" {
						return domain
					}
				}
			}
		case string:
			if domain := domainFromEmail(value); domain != "" {
				return domain
			}
		}
	}
	return ""
}

func domainFromEmail(value string) string {
	value = pyStrip(value)
	if value == "" {
		return ""
	}
	if strings.HasPrefix(strings.ToLower(value), "mailto:") {
		value = value[len("mailto:"):]
	}
	address := value
	if parsed, err := mail.ParseAddress(value); err == nil && parsed.Address != "" {
		address = parsed.Address
	}
	_, domain, ok := strings.Cut(address, "@")
	if !ok {
		return ""
	}
	return normalizeDomain(domain)
}

// normalizeDomain lowercases, trims dots, and IDNA-encodes; like Python's
// fallback, an un-encodable name is returned as-is.
func normalizeDomain(value string) string {
	domain := strings.Trim(strings.ToLower(pyStrip(value)), ".")
	if domain == "" {
		return ""
	}
	if encoded, err := idna.ToASCII(domain); err == nil {
		return encoded
	}
	return domain
}

func sleep(ctx context.Context, d time.Duration) error {
	if d <= 0 {
		return nil
	}
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
