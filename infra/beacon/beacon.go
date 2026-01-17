package main

import (
	"context"
	"errors"
	"flag"
	"log"
	"net"
	"os"
	"path/filepath"
	"strings"
	"time"

	dnstap "github.com/dnstap/golang-dnstap"
	"github.com/miekg/dns"
	"github.com/redis/go-redis/v9"
	"google.golang.org/protobuf/proto"
	"crypto/tls"
)

func main() {
	var (
		socketPath = flag.String("socket", "/run/knot-dnstap/dnstap.sock", "UNIX socket path to listen on (dnstap framestream)")
		zoneSuffix = flag.String("zone", "r.nossl.sh.", "Only accept queries under this FQDN suffix (must end with dot)")
		keyPrefix  = flag.String("prefix", "beacon:", "Redis key prefix")
		ttl        = flag.Duration("ttl", 24*time.Hour, "Redis TTL for mapping keys")

		redisAddr = flag.String("redis", "127.0.0.1:6379", "Redis host:port")
		redisUser = flag.String("redis-user", "", "Redis username (ACL, optional)")
		redisPass = flag.String("redis-pass", "", "Redis password (optional)")
		redisDB   = flag.Int("redis-db", 0, "Redis DB number")
		redisTLS  = flag.Bool("redis-tls", false, "Use TLS for Redis connection (optional)")
	)
	flag.Parse()

	// Ensure socket directory exists
	if err := os.MkdirAll(filepath.Dir(*socketPath), 0755); err != nil {
		log.Fatalf("mkdir socket dir: %v", err)
	}

	// If stale socket exists, remove it (helps after crashes)
	_ = os.Remove(*socketPath)

	ro := &redis.Options{
		Addr:     *redisAddr,
		Username: *redisUser,
		Password: *redisPass,
		DB:       *redisDB,
	}
	if *redisTLS {
		ro.TLSConfig = &tls.Config{MinVersion: tls.VersionTLS12}
	}
	rdb := redis.NewClient(ro)

	{
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		if err := rdb.Ping(ctx).Err(); err != nil {
			log.Fatalf("redis ping failed: %v", err)
		}
	}

	// This creates/listens on the unix socket; Knot will connect as a client.
	input, err := dnstap.NewFrameStreamSockInputFromPath(*socketPath)
	if err != nil {
		log.Fatalf("failed to create framestream sock input: %v", err)
	}

	frames := make(chan []byte, 4096)
	go input.ReadInto(frames)

	zoneLower := strings.ToLower(*zoneSuffix)
	if !strings.HasSuffix(zoneLower, ".") {
		zoneLower += "."
	}

	log.Printf("dnstap socket=%s zone=%s redis=%s ttl=%s", *socketPath, zoneLower, *redisAddr, ttl.String())

	for frame := range frames {
		var dt dnstap.Dnstap
		if err := proto.Unmarshal(frame, &dt); err != nil {
			continue
		}
		msg := dt.GetMessage()
		if msg == nil {
			continue
		}

		// Only process "authoritative server received a query".
		if msg.GetType() != dnstap.Message_AUTH_QUERY {
			continue
		}

		resolverIP, err := ipFromDnstap(msg.GetSocketFamily(), msg.GetQueryAddress())
		if err != nil {
			continue
		}

		dm, qname, qtype, ecs, err := parseDNSQuery(msg.GetQueryMessage())
		_ = dm
		if err != nil {
			continue
		}

		qnameLower := strings.ToLower(dns.Fqdn(qname))
		if !strings.HasSuffix(qnameLower, zoneLower) {
			continue
		}

		uniq := firstLabel(qnameLower) // <uniqkey>.r.nossl.sh
		if uniq == "" {
			continue
		}

		key := *keyPrefix + uniq
		ts := time.Now().Unix()
		fields := map[string]interface{}{
			"resolver_ip": resolverIP,
			"ecs":         ecs,
			"qtype":       qtype,
			"ts":          ts,
		}
		switch qtype {
		case "A", "AAAA":
			suffix := strings.ToLower(qtype)
			fields["resolver_ip_"+suffix] = resolverIP
			fields["ecs_"+suffix] = ecs
			fields["ts_"+suffix] = ts
		}

		ctx, cancel := context.WithTimeout(context.Background(), 250*time.Millisecond)
		pipe := rdb.Pipeline()
		pipe.HSet(ctx, key, fields)
		pipe.Expire(ctx, key, *ttl)
		_, _ = pipe.Exec(ctx)
		cancel()
	}
}

func parseDNSQuery(wire []byte) (*dns.Msg, string, string, string, error) {
	if len(wire) == 0 {
		return nil, "", "", "", errors.New("empty wire")
	}
	var m dns.Msg
	if err := m.Unpack(wire); err != nil {
		return nil, "", "", "", err
	}
	if len(m.Question) == 0 {
		return &m, "", "", "", errors.New("no question")
	}
	q := m.Question[0]
	ecs := extractECS(&m)
	return &m, q.Name, dns.TypeToString[q.Qtype], ecs, nil
}

// ECS is EDNS0 option code 8.
// We return "IP/prefix" like "203.0.113.0/24" or "" if absent.
func extractECS(m *dns.Msg) string {
	opt := m.IsEdns0()
	if opt == nil {
		return ""
	}
	for _, o := range opt.Option {
		if s, ok := o.(*dns.EDNS0_SUBNET); ok {
			ip := net.IP(s.Address)
			if s.Family == 1 { // IPv4
				ip = ip.To4()
			}
			if ip == nil {
				return ""
			}
			return ip.String() + "/" + itoa(int(s.SourceNetmask))
		}
	}
	return ""
}

func ipFromDnstap(fam dnstap.SocketFamily, b []byte) (string, error) {
	ip := net.IP(b)
	if fam == dnstap.SocketFamily_INET {
		ip = ip.To4()
	}
	if ip == nil {
		return "", errors.New("invalid ip bytes")
	}
	return ip.String(), nil
}

func firstLabel(fqdn string) string {
	fqdn = strings.TrimSuffix(fqdn, ".")
	parts := strings.SplitN(fqdn, ".", 2)
	if len(parts) == 0 {
		return ""
	}
	return parts[0]
}

// tiny int->string without fmt (faster, fewer deps)
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [32]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + (n % 10))
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}
