// Package config reads the worker settings from the environment
// (/etc/nossl/worker.env on the VM, see infra/init/nossl-worker.env.example).
package config

import (
	"os"
	"strings"
)

type Config struct {
	DataDir string

	PGSQL string

	R2AccountID       string
	R2Bucket          string
	R2AccessKeyID     string
	R2SecretAccessKey string

	GitHubToken string
	GitHubRepo  string

	HCPingASN string
}

func FromEnv() Config {
	return Config{
		DataDir:           env("NOSSL_DATA_DIR", "/var/lib/nossl"),
		PGSQL:             env("PGSQL", ""),
		R2AccountID:       env("R2_ACCOUNT_ID", ""),
		R2Bucket:          env("R2_BUCKET", "nossl-sh-dbs"),
		R2AccessKeyID:     env("R2_ACCESS_KEY_ID", ""),
		R2SecretAccessKey: env("R2_SECRET_ACCESS_KEY", ""),
		GitHubToken:       env("GITHUB_TOKEN", ""),
		GitHubRepo:        env("GITHUB_REPO", "shingrus/nossl.sh"),
		HCPingASN:         env("HC_PING_ASN", ""),
	}
}

func env(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}
