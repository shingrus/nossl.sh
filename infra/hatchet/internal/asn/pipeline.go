package asn

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"nossl.sh/hatchet/internal/config"
	"nossl.sh/hatchet/internal/publish"
	"nossl.sh/mmdb-builder/mmdb"
)

const (
	sourceRepoURL   = "https://github.com/ipverse/asn-ip"
	mmdbFileFormat  = "ip2asn-nossl-sh-%s.mmdb"
	sqliteFileName  = "asn.sqlite3"
	releaseAsset    = "ip2asn-nossl-sh.mmdb"
	keepOutputDirs  = 3
	dateTagLayout   = "20060102"
	dateFolderShape = "2006-01-02"
)

// Pipeline runs the ASN database build. Each method is one step; the Hatchet
// workflow and the local "run" command call them in the same order.
type Pipeline struct {
	Config   config.Config
	Progress func(string)
}

// Source identifies the asn-ip snapshot a run works on.
type Source struct {
	Commit  string `json:"commit"`
	DateTag string `json:"date_tag"`
}

func (p *Pipeline) repoDir() string { return filepath.Join(p.Config.DataDir, "repos", "asn-ip") }
func (p *Pipeline) asDir() string   { return filepath.Join(p.repoDir(), "as") }

func (p *Pipeline) outDir(dateTag string) string {
	return filepath.Join(p.Config.DataDir, "out", "asn", dateTag)
}

func (p *Pipeline) log(format string, args ...any) {
	if p.Progress != nil {
		p.Progress(fmt.Sprintf(format, args...))
	}
}

// SyncSource clones ipverse/asn-ip once and afterwards updates it in place.
func (p *Pipeline) SyncSource(ctx context.Context, now time.Time) (Source, error) {
	repo := p.repoDir()
	if _, err := os.Stat(filepath.Join(repo, ".git")); err == nil {
		p.log("sync: updating %s", repo)
		if err := runGit(ctx, "-C", repo, "fetch", "--depth", "1", "origin", "HEAD"); err != nil {
			return Source{}, err
		}
		if err := runGit(ctx, "-C", repo, "reset", "--hard", "FETCH_HEAD"); err != nil {
			return Source{}, err
		}
		if err := runGit(ctx, "-C", repo, "clean", "-fdq"); err != nil {
			return Source{}, err
		}
	} else {
		p.log("sync: cloning %s into %s", sourceRepoURL, repo)
		if err := os.RemoveAll(repo); err != nil {
			return Source{}, err
		}
		if err := os.MkdirAll(filepath.Dir(repo), 0o750); err != nil {
			return Source{}, err
		}
		if err := runGit(ctx, "clone", "--depth", "1", "--single-branch", sourceRepoURL, repo); err != nil {
			return Source{}, err
		}
	}
	commit, err := p.headCommit(ctx)
	if err != nil {
		return Source{}, err
	}
	src := Source{Commit: commit, DateTag: now.UTC().Format(dateTagLayout)}
	p.log("sync: asn-ip at %s", commit)
	return src, nil
}

// checkSource fails when the checkout moved since SyncSource, so every step of
// a run reads the same snapshot.
func (p *Pipeline) checkSource(ctx context.Context, src Source) error {
	commit, err := p.headCommit(ctx)
	if err != nil {
		return err
	}
	if commit != src.Commit {
		return fmt.Errorf("asn-ip checkout moved from %s to %s during the run", src.Commit, commit)
	}
	return nil
}

func (p *Pipeline) headCommit(ctx context.Context) (string, error) {
	out, err := exec.CommandContext(ctx, "git", "-C", p.repoDir(), "rev-parse", "HEAD").Output()
	if err != nil {
		return "", fmt.Errorf("git rev-parse: %w", err)
	}
	return strings.TrimSpace(string(out)), nil
}

func (p *Pipeline) parse(ctx context.Context, src Source) (ParseResult, error) {
	if err := p.checkSource(ctx, src); err != nil {
		return ParseResult{}, err
	}
	warnings := 0
	result, err := ParseDir(p.asDir(), func(msg string) {
		warnings++
		if warnings <= 20 {
			p.log("%s", msg)
		}
	})
	if warnings > 20 {
		p.log("parse: %d more warnings not shown", warnings-20)
	}
	return result, err
}

func (p *Pipeline) openStore(ctx context.Context) (*Store, error) {
	if p.Config.PGSQL == "" {
		return nil, fmt.Errorf("PGSQL is not set")
	}
	store, err := OpenStore(ctx, p.Config.PGSQL)
	if err != nil {
		return nil, err
	}
	if err := store.EnsureSchema(ctx); err != nil {
		store.Close()
		return nil, err
	}
	return store, nil
}

// Ingest writes changed ASN rows to Postgres.
func (p *Pipeline) Ingest(ctx context.Context, src Source) (IngestStats, error) {
	parsed, err := p.parse(ctx, src)
	if err != nil {
		return IngestStats{}, err
	}
	p.log("ingest: parsed %d ASNs (%d skipped)", len(parsed.Records), parsed.Skipped)
	store, err := p.openStore(ctx)
	if err != nil {
		return IngestStats{}, err
	}
	defer store.Close()
	stats, err := store.Ingest(ctx, parsed.Records)
	if err != nil {
		return stats, err
	}
	p.log("ingest: inserted=%d updated=%d unchanged=%d stale=%d",
		stats.Inserted, stats.Updated, stats.Unchanged, stats.Stale)
	return stats, nil
}

// Domains fills missing ASN domains in Postgres.
func (p *Pipeline) Domains(ctx context.Context) (DomainStats, error) {
	store, err := p.openStore(ctx)
	if err != nil {
		return DomainStats{}, err
	}
	defer store.Close()
	stats, err := FillDomains(ctx, store, DefaultDomainOptions(), p.Progress)
	if err == nil {
		p.log("domains: done processed=%d pdb=%d rdap=%d not_found=%d failed=%d",
			stats.Processed, stats.FromPDB, stats.FromRDAP, stats.NotFound, stats.Failed)
	}
	return stats, err
}

// BuildMMDBOutput describes the built ip2asn MMDB.
type BuildMMDBOutput struct {
	Path     string `json:"path"`
	Entries  int    `json:"entries"`
	Prefixes int    `json:"prefixes"`
}

// BuildMMDB builds the ip2asn MMDB from the synced snapshot.
func (p *Pipeline) BuildMMDB(ctx context.Context, src Source) (BuildMMDBOutput, error) {
	if err := p.checkSource(ctx, src); err != nil {
		return BuildMMDBOutput{}, err
	}
	dir := p.outDir(src.DateTag)
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return BuildMMDBOutput{}, err
	}
	final := filepath.Join(dir, fmt.Sprintf(mmdbFileFormat, src.DateTag))
	tmp := final + ".tmp"
	stats, err := mmdb.BuildASN(p.asDir(), tmp, false)
	if err != nil {
		os.Remove(tmp)
		return BuildMMDBOutput{}, err
	}
	if err := os.Rename(tmp, final); err != nil {
		return BuildMMDBOutput{}, err
	}
	p.log("mmdb: wrote %s (%d ASNs, %d prefixes, %d skipped)", final, stats.Entries, stats.Prefixes, stats.Skipped)
	return BuildMMDBOutput{Path: final, Entries: stats.Entries, Prefixes: stats.Prefixes}, nil
}

// ExportOutput describes the exported SQLite file.
type ExportOutput struct {
	Path  string      `json:"path"`
	Stats ExportStats `json:"stats"`
}

// ExportSQLite writes asn.sqlite3 for the website from Postgres-backed data.
func (p *Pipeline) ExportSQLite(ctx context.Context, src Source) (ExportOutput, error) {
	parsed, err := p.parse(ctx, src)
	if err != nil {
		return ExportOutput{}, err
	}
	store, err := p.openStore(ctx)
	if err != nil {
		return ExportOutput{}, err
	}
	defer store.Close()
	stale, err := store.StaleRecords(ctx, parsed.Records)
	if err != nil {
		return ExportOutput{}, err
	}
	domains, err := store.Domains(ctx)
	if err != nil {
		return ExportOutput{}, err
	}
	geo, err := store.GeoPDB(ctx)
	if err != nil {
		return ExportOutput{}, err
	}

	dir := p.outDir(src.DateTag)
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return ExportOutput{}, err
	}
	final := filepath.Join(dir, sqliteFileName)
	tmp := final + ".tmp"
	stats, err := ExportSQLite(ctx, tmp, append(parsed.Records, stale...), domains, geo)
	if err != nil {
		os.Remove(tmp)
		return ExportOutput{}, err
	}
	if err := os.Rename(tmp, final); err != nil {
		return ExportOutput{}, err
	}
	p.log("export: wrote %s (asns=%d domains=%d geo_pdb=%d)", final, stats.ASNs, stats.Domains, stats.GeoPDB)
	return ExportOutput{Path: final, Stats: stats}, nil
}

// PublishOutput lists where artifacts went.
type PublishOutput struct {
	Uploads []string `json:"uploads"`
}

// Publish uploads the MMDB and SQLite file to R2 (dated folder the pull agent
// reads) and the MMDB to the GitHub release, then pings the freshness check.
func (p *Pipeline) Publish(ctx context.Context, src Source, mmdbPath, sqlitePath string) (PublishOutput, error) {
	out := PublishOutput{}
	r2, err := publish.NewR2(p.Config.R2AccountID, p.Config.R2AccessKeyID, p.Config.R2SecretAccessKey, p.Config.R2Bucket)
	if err != nil {
		return out, err
	}
	gh, err := publish.NewGitHubRelease(p.Config.GitHubToken, p.Config.GitHubRepo)
	if err != nil {
		return out, err
	}
	date, err := time.Parse(dateTagLayout, src.DateTag)
	if err != nil {
		return out, err
	}
	folder := date.Format(dateFolderShape)
	for _, path := range []string{mmdbPath, sqlitePath} {
		location, err := r2.Upload(ctx, folder+"/"+filepath.Base(path), path)
		if err != nil {
			return out, err
		}
		p.log("publish: %s", location)
		out.Uploads = append(out.Uploads, location)
	}
	location, err := gh.UploadAsset(ctx, mmdbPath, releaseAsset, src.DateTag)
	if err != nil {
		return out, err
	}
	p.log("publish: %s", location)
	out.Uploads = append(out.Uploads, location)

	if err := publish.Ping(ctx, p.Config.HCPingASN); err != nil {
		p.log("publish: healthcheck ping failed: %v", err)
	}
	p.pruneOutputs()
	return out, nil
}

// pruneOutputs keeps the newest few dated output directories.
func (p *Pipeline) pruneOutputs() {
	root := filepath.Join(p.Config.DataDir, "out", "asn")
	entries, err := os.ReadDir(root)
	if err != nil {
		return
	}
	var dirs []string
	for _, e := range entries {
		if e.IsDir() {
			dirs = append(dirs, e.Name())
		}
	}
	sort.Strings(dirs)
	for len(dirs) > keepOutputDirs {
		os.RemoveAll(filepath.Join(root, dirs[0]))
		dirs = dirs[1:]
	}
}

func runGit(ctx context.Context, args ...string) error {
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Stdout = os.Stderr
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("git %s: %w", strings.Join(args, " "), err)
	}
	return nil
}
